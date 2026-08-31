#!/usr/bin/env bash
#
# Load an untrusted markdown file into an Azure Pipelines variable, without
# letting its contents act as pipeline instructions.
#
# The API-report and bundle-size comment bodies are produced by jobs that run
# pull-request code, so their *content* is attacker-controlled. As comment text
# that is fine. As something echoed to stdout in a job that holds a credential it
# is not: the agent scans every line of step output for logging commands, so a
# body containing `##vso[task.setvariable variable=DEPLOYMENT_SERVER]…` would be
# obeyed rather than printed.
#
# This script therefore neutralises every `##vso[` and `##[` sequence before the
# body reaches stdout, encodes the result the way the agent expects (`%` first,
# so the escapes introduced afterwards are not themselves re-escaped), and only
# then emits a single setvariable command it composed itself.
#
# Usage:
#   strip-logging-commands.sh <file> <bodyVariable> <flagVariable>
#
# Sets <bodyVariable> to the neutralised contents and <flagVariable> to "true"
# when the file exists and is non-empty, or "false" otherwise.

set -euo pipefail

if test "$#" -ne 3; then
    echo "usage: strip-logging-commands.sh <file> <bodyVariable> <flagVariable>" >&2
    exit 2
fi

FILE="$1"
BODY_VARIABLE="$2"
FLAG_VARIABLE="$3"

# Variable names are interpolated into a logging command below, so they must not
# be able to carry one.
for name in "$BODY_VARIABLE" "$FLAG_VARIABLE"; do
    case "$name" in
        "" | *[!A-Za-z0-9_]*)
            echo "Refusing to set '$name': variable names must be [A-Za-z0-9_]." >&2
            exit 2
            ;;
    esac
done

if ! test -s "$FILE"; then
    echo "No comment body at $FILE; nothing to post."
    echo "##vso[task.setvariable variable=${FLAG_VARIABLE}]false"
    exit 0
fi

# Order matters. `%` must be encoded before the CR/LF escapes are introduced, or
# the `%` in `%0A` is itself rewritten to `%AZP25` and the agent decodes the
# body back into something that is not what was checked. `##vso[` and `##[` are
# defanged with a zero-width-free marker that stays readable in the posted
# comment.
BODY=$(sed -e 's/%/%AZP25/g' -e 's/##vso\[/##vso(/g' -e 's/##\[/##(/g' "$FILE")

# Re-encode the newlines that command substitution stripped, plus any CR.
BODY=${BODY//$'\r'/%0D}
BODY=${BODY//$'\n'/%0A}

printf 'Loaded %s bytes of comment body from %s.\n' "${#BODY}" "$FILE"
echo "##vso[task.setvariable variable=${BODY_VARIABLE}]${BODY}"
echo "##vso[task.setvariable variable=${FLAG_VARIABLE}]true"
