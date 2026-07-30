package indicatorsfacade

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type childResult struct {
	stdout               []byte
	outputBytes          int
	exitCode             *int
	timedOut             bool
	truncated            bool
	durationMilliseconds int64
}

type boundedOutput struct {
	mu       sync.Mutex
	maximum  int64
	total    int64
	exceeded chan struct{}
	once     sync.Once
}

func newBoundedOutput(maximum int64) *boundedOutput {
	return &boundedOutput{maximum: maximum, exceeded: make(chan struct{})}
}

func (b *boundedOutput) read(reader io.Reader) ([]byte, error) {
	result := make([]byte, 0, minInt64(b.maximum, 64<<10))
	buffer := make([]byte, 32<<10)
	for {
		count, err := reader.Read(buffer)
		if count > 0 {
			b.mu.Lock()
			remaining := b.maximum - b.total
			if remaining < int64(count) {
				b.total += int64(count)
				b.once.Do(func() { close(b.exceeded) })
				b.mu.Unlock()
				return nil, fmt.Errorf("combined output exceeds limit")
			}
			b.total += int64(count)
			b.mu.Unlock()
			result = append(result, buffer[:count]...)
		}
		if err == io.EOF {
			return result, nil
		}
		if err != nil {
			return nil, err
		}
	}
}

func (b *boundedOutput) count() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return int(b.total)
}

type pipeRead struct {
	data []byte
	err  error
}

type processWait struct {
	err         error
	completedAt time.Time
}

func executeRealCLI(ctx context.Context, config RunnerConfig, argv []string, guard Guard) (childResult, error) {
	command := exec.Command(config.RealCLIPath, argv...)
	command.Env = trustedChildEnvironment(config)
	command.Dir = config.WorkingDirectory
	configureProcessGroup(command)

	devNull, err := os.Open(os.DevNull)
	if err != nil {
		return childResult{}, deny(CodeRealCLIExecutionFailed, "无法建立受控子进程", err)
	}
	defer devNull.Close()
	command.Stdin = devNull
	stdoutPipe, err := command.StdoutPipe()
	if err != nil {
		return childResult{}, deny(CodeRealCLIExecutionFailed, "无法建立受控子进程", err)
	}
	stderrPipe, err := command.StderrPipe()
	if err != nil {
		return childResult{}, deny(CodeRealCLIExecutionFailed, "无法建立受控子进程", err)
	}
	if err := command.Start(); err != nil {
		return childResult{}, deny(CodeRealCLIExecutionFailed, "真实 CLI 启动失败", err)
	}
	executionStarted := time.Now()

	budget := newBoundedOutput(config.Limits.MaxOutputBytes)
	stdoutRead := make(chan pipeRead, 1)
	stderrRead := make(chan pipeRead, 1)
	go func() {
		data, readErr := budget.read(stdoutPipe)
		stdoutRead <- pipeRead{data: data, err: readErr}
	}()
	go func() {
		data, readErr := budget.read(stderrPipe)
		stderrRead <- pipeRead{data: data, err: readErr}
	}()
	waitResult := make(chan processWait, 1)
	go func() {
		waitResult <- processWait{err: command.Wait(), completedAt: time.Now()}
	}()

	ticker := time.NewTicker(config.Limits.PollInterval)
	defer ticker.Stop()
	deadline := executionStarted.Add(config.Limits.Timeout)
	timeout := time.NewTimer(time.Until(deadline))
	defer timeout.Stop()

	for {
		select {
		case waited := <-waitResult:
			// A successful CLI must not leave helpers holding inherited pipes or
			// continuing outside the invocation lifetime.
			killProcessGroup(command)
			stdout := <-stdoutRead
			stderr := <-stderrRead
			result := childResult{
				stdout: stdout.data, outputBytes: budget.count(), exitCode: processExitCode(waited.err),
				truncated:            stdout.err != nil || stderr.err != nil,
				durationMilliseconds: waited.completedAt.Sub(executionStarted).Milliseconds(),
			}
			// The timer and Wait result can become ready in the same select cycle.
			// Decide from the recorded process completion time so select ordering
			// cannot allow a command that actually crossed the hard deadline.
			if !finishedBeforeDeadline(waited.completedAt, deadline) {
				result.stdout = nil
				result.timedOut = true
				return result, deny(CodeExecutionLimitExceeded, "真实 CLI 执行超时", nil)
			}
			if stdout.err != nil || stderr.err != nil {
				result.stdout = nil
				return result, deny(CodeExecutionLimitExceeded, "真实 CLI 输出超过部署限额", firstError(stdout.err, stderr.err))
			}
			if waited.err != nil {
				result.stdout = nil
				return result, deny(CodeRealCLIExecutionFailed, "真实 CLI 执行失败", waited.err)
			}
			return result, nil
		case <-budget.exceeded:
			waited := killAndWait(command, waitResult)
			return childResult{
				outputBytes: budget.count(), exitCode: processExitCode(waited.err), truncated: true,
				durationMilliseconds: time.Since(executionStarted).Milliseconds(),
			}, deny(CodeExecutionLimitExceeded, "真实 CLI 输出超过部署限额", nil)
		case <-ticker.C:
			if err := guard.Revalidate(ctx); err != nil {
				waited := killAndWait(command, waitResult)
				return childResult{
					outputBytes: budget.count(), exitCode: processExitCode(waited.err),
					durationMilliseconds: time.Since(executionStarted).Milliseconds(),
				}, err
			}
		case <-timeout.C:
			waited := killAndWait(command, waitResult)
			return childResult{
				outputBytes: budget.count(), exitCode: processExitCode(waited.err), timedOut: true,
				durationMilliseconds: time.Since(executionStarted).Milliseconds(),
			}, deny(CodeExecutionLimitExceeded, "真实 CLI 执行超时", nil)
		case <-ctx.Done():
			waited := killAndWait(command, waitResult)
			return childResult{
				outputBytes: budget.count(), exitCode: processExitCode(waited.err),
				durationMilliseconds: time.Since(executionStarted).Milliseconds(),
			}, deny(CodeRequesterContextExpired, "请求已取消或权限上下文失效", ctx.Err())
		}
	}
}

func trustedChildEnvironment(config RunnerConfig) []string {
	environment := []string{
		"LANG=C.UTF-8",
		"LC_ALL=C.UTF-8",
		"TZ=UTC",
		"QDM_INDICATORS_CONFIG_DIR=" + config.RealCLIConfigDir,
	}
	for _, entry := range config.ExtraChildEnv {
		name, value, ok := strings.Cut(entry, "=")
		if !ok || !filepath.IsAbs(value) {
			continue
		}
		if name == "SSL_CERT_FILE" || name == "SSL_CERT_DIR" {
			environment = append(environment, entry)
		}
	}
	return environment
}

func killAndWait(command *exec.Cmd, waitResult <-chan processWait) processWait {
	killProcessGroup(command)
	select {
	case waited := <-waitResult:
		return waited
	case <-time.After(5 * time.Second):
		return processWait{
			err:         fmt.Errorf("timed out waiting for terminated process group"),
			completedAt: time.Now(),
		}
	}
}

func processExitCode(err error) *int {
	if err == nil {
		value := 0
		return &value
	}
	var exitError *exec.ExitError
	if !errors.As(err, &exitError) {
		return nil
	}
	value := exitError.ExitCode()
	return &value
}

func finishedBeforeDeadline(completedAt, deadline time.Time) bool {
	return completedAt.Before(deadline)
}

func firstError(errors ...error) error {
	for _, err := range errors {
		if err != nil {
			return err
		}
	}
	return nil
}

func minInt64(left, right int64) int {
	if left < right {
		return int(left)
	}
	return int(right)
}
