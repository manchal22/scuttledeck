{{- define "scuttledeck.fullname" -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end }}

{{- define "scuttledeck.labels" -}}
app.kubernetes.io/name: scuttledeck
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end }}

{{- define "scuttledeck.secretName" -}}
{{ include "scuttledeck.fullname" . }}-secrets
{{- end }}

{{- define "scuttledeck.postgresHost" -}}
{{ include "scuttledeck.fullname" . }}-postgres
{{- end }}

{{- define "scuttledeck.ingestTag" -}}
{{ .Values.ingest.image.tag | default "latest" }}
{{- end }}

{{- define "scuttledeck.webTag" -}}
{{ .Values.web.image.tag | default "latest" }}
{{- end }}
