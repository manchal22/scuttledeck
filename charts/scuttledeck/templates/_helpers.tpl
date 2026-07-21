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

{{- /*
Generated credentials, computed once per render and cached, so the Secret
and NOTES.txt always agree. Precedence: explicit value > existing live
Secret (upgrades never rotate silently) > freshly generated.
*/ -}}
{{- define "scuttledeck.creds" -}}
{{- if not (hasKey .Values "_credsCache") -}}
{{- $existing := (lookup "v1" "Secret" .Release.Namespace (include "scuttledeck.secretName" .)) | default dict -}}
{{- $data := $existing.data | default dict -}}
{{- $webhook := .Values.github.webhookSecret | default (get $data "GITHUB_WEBHOOK_SECRET" | b64dec) | default (randAlphaNum 40) -}}
{{- $token := .Values.ingest.token | default (get $data "INGEST_TOKEN" | b64dec) | default (randAlphaNum 40) -}}
{{- $pg := .Values.postgres.password | default (get $data "POSTGRES_PASSWORD" | b64dec) | default (randAlphaNum 32) -}}
{{- $dash := .Values.web.password | default (get $data "DASHBOARD_PASSWORD" | b64dec) | default (randAlphaNum 24) -}}
{{- $_ := set .Values "_credsCache" (dict "webhookSecret" $webhook "ingestToken" $token "pgPassword" $pg "dashboardPassword" $dash) -}}
{{- end -}}
{{- get .Values "_credsCache" | toJson -}}
{{- end }}

{{- define "scuttledeck.ingestTag" -}}
{{ .Values.ingest.image.tag | default "latest" }}
{{- end }}

{{- define "scuttledeck.webTag" -}}
{{ .Values.web.image.tag | default "latest" }}
{{- end }}
