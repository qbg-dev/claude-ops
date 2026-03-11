#compdef fleet
# Fleet CLI — zsh completions
# Install: add `fpath=(~/.tmux-agents/completions $fpath)` to .zshrc, then `compinit`

_fleet_workers() {
  local project
  project=$(git rev-parse --show-toplevel 2>/dev/null | xargs basename | sed 's/-w-.*//')
  if [[ -z "$project" ]]; then
    project=$(ls -1 ~/.claude/fleet/ 2>/dev/null | head -1)
  fi
  [[ -z "$project" ]] && return

  local -a workers
  workers=($(ls -1 ~/.claude/fleet/$project/ 2>/dev/null | grep -v -E '^(_user|missions|fleet\.json|registry\.json)$'))
  _describe 'worker' workers
}

_fleet_windows() {
  local -a windows
  windows=($(tmux list-windows -F '#{window_name}' 2>/dev/null))
  _describe 'window' windows
}

_fleet_projects() {
  local -a projects
  projects=($(ls -1 ~/.claude/fleet/ 2>/dev/null | grep -v '^\.' | grep -v 'defaults\.json'))
  _describe 'project' projects
}

_fleet() {
  local -a commands
  commands=(
    'setup:Bootstrap fleet infrastructure'
    'create:Create and launch a worker'
    'run:Launch an interactive worker'
    'start:Start or restart a worker'
    'restart:Start or restart a worker'
    'stop:Graceful stop a worker'
    'ls:List all workers'
    'list:List all workers'
    'status:Fleet overview dashboard'
    'attach:Focus a worker tmux pane'
    'config:Get/set worker config'
    'cfg:Get/set worker config'
    'defaults:Get/set global defaults'
    'log:Tail worker tmux pane output'
    'logs:Tail worker tmux pane output'
    'mail:Check worker Fleet Mail inbox'
    'mail-server:Fleet Mail server management'
    'fork:Fork from existing session'
    'mcp:Manage MCP server registration'
    'setup-agent:Launch fleet configuration agent'
    'nuke:Remove all fleet artifacts'
    'doctor:Verify fleet health'
    'onboard:Setup + launch fleet architect'
    'tui:Launch Fleet Mail TUI client'
    'layout:Save/restore tmux window layouts'
  )

  _arguments -C \
    '(-v --version)'{-v,--version}'[Show version]' \
    '(-p --project)'{-p,--project}'[Override project]:project:_fleet_projects' \
    '--json[JSON output]' \
    '(-h --help)'{-h,--help}'[Show help]' \
    '1:command:->cmd' \
    '*::arg:->args'

  case $state in
    cmd)
      _describe 'command' commands
      ;;
    args)
      case $words[1] in
        create)
          _arguments \
            '(-m --model)'{-m,--model}'[Model]:model:(opus sonnet haiku)' \
            '(-e --effort)'{-e,--effort}'[Reasoning effort]:effort:(high max)' \
            '--save[Save as template]' \
            '1:name:' \
            '2:mission:'
          ;;
        start|restart)
          _arguments \
            '--all[Start all workers]' \
            '(-m --model)'{-m,--model}'[Model override]:model:(opus sonnet haiku)' \
            '1:worker:_fleet_workers'
          ;;
        stop)
          _arguments \
            '--all[Stop all workers]' \
            '1:worker:_fleet_workers'
          ;;
        attach|log|logs|mail)
          _arguments '1:worker:_fleet_workers'
          ;;
        config|cfg)
          _arguments \
            '1:worker:_fleet_workers' \
            '2:key:(model reasoning_effort permission_mode sleep_duration window worktree branch)' \
            '3:value:'
          ;;
        defaults)
          _arguments \
            '1:key:(model effort permission_mode sleep_duration fleet_mail_url fleet_mail_token)' \
            '2:value:'
          ;;
        fork)
          _arguments \
            '1:parent:_fleet_workers' \
            '2:child:' \
            '3:mission:'
          ;;
        run)
          _arguments \
            '1:worker:_fleet_workers' \
            '2:command:'
          ;;
        mail-server)
          _arguments '1:action:(connect disconnect status start)'
          ;;
        mcp)
          _arguments '1:action:(register status)'
          ;;
        tui)
          _arguments \
            '(-a --account)'{-a,--account}'[Account name]:worker:_fleet_workers' \
            '--control[Open in control window pane]'
          ;;
        layout)
          _arguments \
            '1:action:(save restore list ls delete rm)' \
            '2:window:_fleet_windows'
          ;;
        doctor)
          _arguments '--fix[Auto-fix issues]'
          ;;
        ls|list)
          _arguments '--json[JSON output]'
          ;;
      esac
      ;;
  esac
}

_fleet "$@"
