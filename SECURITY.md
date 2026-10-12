# Security Policy

## Supported Versions

Only the latest released version receives security fixes. The web protocol may
change independently of this project, so keep the plugin updated and pin a
known-good version in production.

## Reporting a Vulnerability

Do not include `userToken`, cookies, Magpie auth files, or complete upstream
requests in an issue. Report security problems privately to the repository
maintainer and redact all credentials from logs and captures.

The plugin is designed for local use. It does not provide a hosted credential
store, telemetry service, or shared account proxy.
