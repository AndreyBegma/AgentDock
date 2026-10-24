{{- define "nautelle.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "nautelle.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/* Labels; the component goes in as "component" of a dict with "root". */}}
{{- define "nautelle.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .root.Chart.Name .root.Chart.Version | replace "+" "_" }}
{{ include "nautelle.selectorLabels" . }}
app.kubernetes.io/version: {{ .root.Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
app.kubernetes.io/part-of: nautelle
{{- end -}}

{{- define "nautelle.selectorLabels" -}}
app.kubernetes.io/name: {{ include "nautelle.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/* An image reference; a tag may carry its own @sha256 digest. */}}
{{- define "nautelle.image" -}}
{{- printf "%s:%s" .image.repository (default .root.Chart.AppVersion .image.tag) -}}
{{- end -}}

{{/* NAUTELLE_URL without a trailing slash. */}}
{{- define "nautelle.url" -}}
{{- required "nautelleUrl is required" .Values.nautelleUrl | trimSuffix "/" -}}
{{- end -}}

{{- define "nautelle.https" -}}
{{- if hasPrefix "https://" (include "nautelle.url" .) -}}true{{- end -}}
{{- end -}}

{{- define "nautelle.appEnv" -}}
{{- if .Values.appEnv -}}
{{- .Values.appEnv -}}
{{- else if include "nautelle.https" . -}}
production
{{- else -}}
development
{{- end -}}
{{- end -}}

{{- define "nautelle.ingressHost" -}}
{{- default (urlParse (include "nautelle.url" .)).hostname .Values.ingress.host -}}
{{- end -}}

{{/* The Secret the chart keeps the generated bundled passwords in. */}}
{{- define "nautelle.bundledSecret" -}}
{{- printf "%s-bundled" (include "nautelle.fullname" .) -}}
{{- end -}}

{{- define "nautelle.postgresSecret" -}}
{{- default (include "nautelle.bundledSecret" .) .Values.postgresql.auth.existingSecret -}}
{{- end -}}

{{- define "nautelle.postgresSecretKey" -}}
{{- if .Values.postgresql.auth.existingSecret -}}{{ .Values.postgresql.auth.existingSecretKey }}{{- else -}}postgres-password{{- end -}}
{{- end -}}

{{- define "nautelle.redisSecret" -}}
{{- default (include "nautelle.bundledSecret" .) .Values.redis.auth.existingSecret -}}
{{- end -}}

{{- define "nautelle.redisSecretKey" -}}
{{- if .Values.redis.auth.existingSecret -}}{{ .Values.redis.auth.existingSecretKey }}{{- else -}}redis-password{{- end -}}
{{- end -}}

{{/* The Secret holding the external URLs given as plain values. */}}
{{- define "nautelle.externalSecret" -}}
{{- printf "%s-external" (include "nautelle.fullname" .) -}}
{{- end -}}

{{- define "nautelle.tunnelSecret" -}}
{{- default (printf "%s-tunnel" (include "nautelle.fullname" .)) .Values.tunnel.existingSecret -}}
{{- end -}}

{{- define "nautelle.tunnel" -}}
{{- if or .Values.tunnel.token .Values.tunnel.existingSecret -}}true{{- end -}}
{{- end -}}

{{/* One choice for the database and one for Redis: bundled or external. */}}
{{- define "nautelle.validate" -}}
{{- $db := or .Values.externalDatabase.url .Values.externalDatabase.existingSecret -}}
{{- if and .Values.postgresql.enabled $db -}}
{{- fail "set either postgresql.enabled or externalDatabase, not both" -}}
{{- end -}}
{{- if and (not .Values.postgresql.enabled) (not $db) -}}
{{- fail "postgresql.enabled is false: set externalDatabase.url or externalDatabase.existingSecret" -}}
{{- end -}}
{{- $redis := or .Values.externalRedis.url .Values.externalRedis.existingSecret -}}
{{- if and .Values.redis.enabled $redis -}}
{{- fail "set either redis.enabled or externalRedis, not both" -}}
{{- end -}}
{{- if and (not .Values.redis.enabled) (not $redis) -}}
{{- fail "redis.enabled is false: set externalRedis.url or externalRedis.existingSecret" -}}
{{- end -}}
{{- if and .Values.tunnel.token .Values.tunnel.existingSecret -}}
{{- fail "set either tunnel.token or tunnel.existingSecret, not both" -}}
{{- end -}}
{{- end -}}

{{/* Scheduling: a component's own setting wins over the chart-wide one. */}}
{{- define "nautelle.scheduling" -}}
{{- with (default .root.Values.nodeSelector .values.nodeSelector) }}
nodeSelector:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with (default .root.Values.tolerations .values.tolerations) }}
tolerations:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with (default .root.Values.affinity .values.affinity) }}
affinity:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end -}}

{{- define "nautelle.imagePullSecrets" -}}
{{- with .Values.imagePullSecrets }}
imagePullSecrets:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end -}}
