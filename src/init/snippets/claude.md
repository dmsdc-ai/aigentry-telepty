## telepty-snippet:claude

**telepty** is the aigentry ecosystem's PTY multiplexer and session orchestrator. It allows wrapping AI CLI sessions under stable IDs and addressing them across local and cross-machine boundaries via a daemon-mediated transport.

Quick-start (5 commands):

    telepty daemon
    telepty allow --id <name> claude
    telepty list
    telepty inject <name> "<prompt>"
    telepty attach <name>

`telepty allow` wraps a CLI under the chosen `<name>`; `telepty list` enumerates known sessions; `telepty inject` sends a prompt to a wrapped session; `telepty attach` interactively connects to one.

Run `telepty --help` for the full command list. Run `telepty <command> --help` for per-command flags.
