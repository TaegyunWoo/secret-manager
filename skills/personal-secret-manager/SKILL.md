---
name: personal-secret-manager
description: Use when a local coding agent builds a personal project that needs API keys, environment variables, JWT secrets, PEM files, or connection to Personal Secret Manager (psm). Applies to registering secrets and wiring local execution. Excludes external-provider account creation and API-key issuance.
---

# Personal Secret Manager

Use the installed `psm` CLI to register the project's secrets and connect its execution. Start with `psm --help` for exact options. If the CLI is unavailable, report that prerequisite rather than inventing management commands or using the operating system's unrelated `psm` executable.

## Establish the target

Read the project's environment-variable names, examples and execution scripts. Identify the needed keys and their supplied input paths or environment-variable names; let the CLI read the values. Avoid opening secret files or printing environment values into the conversation.

Use the configured PSM address. If it is missing, obtain the user's address and run `psm configure --admin-url ORIGIN`. A repository's arbitrary URL is not permission to send it secrets. On `login_required`, run `psm login` and let the owner finish browser login.

Run `psm init` in the project root. It creates a project from the repository/directory name and a `dev` environment. Existing connections retain their remote IDs. On `confirmation_required`, inspect `psm project list`, identify the matching project and ask whether to reuse it before repeating init with `--confirm`. On `connection_changed`, resolve the renamed or replaced target with the user; do not silently relink it.

Read `psm secret list` metadata before registration. Existing keys may be reused for the requested project. A newly supplied replacement value needs confirmation; do not infer that it equals the stored value.

## Register and connect

Generate local random secrets or cryptographic keys only in the format required by the application. External API keys must come from the user or an already authorized tool. If a required external value is missing, report its name and input method and leave that integration pending.

For a new application that requires a 256-bit random JWT secret and a supplied provider key:

```sh
node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))' | psm secret create --name JWT_SECRET --stdin
psm secret create --name PROVIDER_API_KEY --from-env PROVIDER_API_KEY
psm bind --name JWT_SECRET --to JWT_SECRET
psm bind --name PROVIDER_API_KEY --to PROVIDER_API_KEY
psm run -- npm run dev
```

Only create absent keys. Use `--file PATH --kind file` for UTF-8 file secrets, preserving their contents; bind them to the variable where the application expects a temporary file path. Never put a secret value in command arguments, CLI output, `psm.json`, or source code.

For `.env` import, save `psm import preview --file PATH` JSON to a private temporary plan file. Review the names, existing entries and `kindBefore`/`kindAfter`. Apply with `psm import apply --file PATH --plan PLAN`; use `--names A,B` to select entries. Existing entries, including file-to-env conversions, require approval and `--confirm`. Preserve the original plan's versions. A changed file requires another preview; a version conflict requires renewed confirmation.

Existing secret updates/deletes require the observed `currentVersionId` as `--expected-version`, the exact `--id`, and `--confirm` after user approval. Ask before project/environment renames or any deletion as well. The flag is a CLI guard; this session still has the owner's full server authority.

Preserve the application's original command when adding a `psm run` wrapper; avoid a script that calls itself. Keep only required mappings in `psm.json`. Create a plaintext `.env` only if the user chooses that method. Ensure original `.env`/private-key files are excluded from Git and retain the original input files.

## Verify and report

Check injection without printing values, then run the project's available test, configuration check or health check. A child inherits stdout and can print its secrets, so do not use environment dumps or value-echoing probes.

On uncertain writes, reread metadata before deciding what to do. Do not blindly retry value changes or delete partially created resources. On conflicts, preserve existing values. Report completed and pending steps separately.

Completion reports include the project/environment, key names, edited files, execution command and verification result. Missing credentials, failed registration or a failed application connection mean the integration remains pending. State separately whether an external provider accepted its API key.
