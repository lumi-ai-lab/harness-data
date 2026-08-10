package agentauthz

import (
	"strings"
)

var AuthSourceEnvKeys = []string{
	EnvAuthBlob,
	EnvAuthBlobFile,
	EnvAuthUserID,
	EnvRequesterContextDir,
}

func AuthSourceEnvPresent(env map[string]string) bool {
	if env == nil {
		env = environMap()
	}
	for _, key := range AuthSourceEnvKeys {
		if strings.TrimSpace(env[key]) != "" {
			return true
		}
	}
	return false
}

func ScrubAuthSourceEnvCommand(command string) string {
	return "unset " + strings.Join(AuthSourceEnvKeys, " ") + "; " + command
}
