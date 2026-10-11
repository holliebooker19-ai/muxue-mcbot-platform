# A：接入已启动的 ServerBody 控制口；Agent 默认在本机现有登录环境运行。
# 逻辑在 scripts/start-server-play.mjs（只要 Node，WebUI 和绿色版都直接用它）；这里只把参数转过去。
param(
    [Parameter(Mandatory)][string]$ConnectionFile,
    [ValidateSet('claude', 'codex', 'dsh')][string]$Agent = 'claude',
    [string]$Nickname = '',
    [string]$ConfigDir = '',
    # 人设和玩家档案所在的记忆目录（<目录>/<Bot 游戏名小写>/persona.md、<目录>/shared/players/*.md），留空用默认位置
    [string]$MemoryDir = '',
    [string]$Model = '',
    [string]$NodePath = '',
    [ValidateSet('low', 'medium', 'high', 'xhigh', 'max', 'ultra')][string]$Effort = 'low',
    # 会话选项，-1 表示用驱动器的默认值（见 scripts/companion.mjs 开头的说明）
    [ValidateRange(-1, 1440)][int]$IdleMinutes = -1,
    [ValidateRange(-1, 1440)][int]$ResumeWindowMin = -1,
    [ValidateRange(-1, 2000000)][int]$RotateTokens = -1,
    [ValidateRange(-1, 100)][int]$MaxRestarts = -1,
    # 保护玩家（8h）：跟随时打靠近玩家的怪；半径 3..12（0 表示用默认 8）、撤退血量 4..16（0 表示默认 8）
    [ValidateSet('on', 'off')][string]$Guard = 'on',
    [ValidateRange(0, 12)][int]$GuardRadius = 0,
    [ValidateRange(0, 16)][int]$GuardLowHealth = 0,
    [ValidateSet('on', 'off')][string]$GuardBow = 'on',
    [ValidateSet('on', 'off')][string]$GuardShield = 'on',
    # 外观：<来源>=<选项>（WebUI 从服务器的列表里选，比如 yes_steve_model:model=ds_whale.ysm），每次接管时套用；留空不改
    [string]$Appearance = '',
    # 建筑蓝图目录（build 用的 <名字>.json，格式见 docs/server_body_protocol.md 的 build）；留空用运行目录 runtime 下的 blueprints
    [string]$BlueprintDir = '',
    # 对 AI 关闭的插件：compat.json 的插件 id，逗号分隔（WebUI 插件页的「给 AI 用」开关）；留空表示全部开启
    [string]$DisabledPlugins = '',
    [switch]$Headless,
    [switch]$PrepareOnly
)
$ErrorActionPreference = 'Stop'
$full = { param($p) $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($p) }
if ($NodePath) { $NodePath = & $full $NodePath } else { $NodePath = (Get-Command node -CommandType Application | Select-Object -First 1).Source }
$a = @((Join-Path $PSScriptRoot 'scripts/start-server-play.mjs'), '--connection-file', (& $full $ConnectionFile), '--agent', $Agent, '--effort', $Effort,
    '--node-path', $NodePath, '--guard', $Guard, '--guard-bow', $GuardBow, '--guard-shield', $GuardShield,
    '--guard-radius', [string]$GuardRadius, '--guard-low-health', [string]$GuardLowHealth,
    '--idle-minutes', [string]$IdleMinutes, '--resume-window-min', [string]$ResumeWindowMin,
    '--rotate-tokens', [string]$RotateTokens, '--max-restarts', [string]$MaxRestarts)
if ($Nickname) { $a += @('--nickname', $Nickname) }
if ($ConfigDir) { $a += @('--config-dir', (& $full $ConfigDir)) }
if ($MemoryDir) { $a += @('--memory-dir', (& $full $MemoryDir)) }
if ($Model) { $a += @('--model', $Model) }
if ($Appearance) { $a += @('--appearance', $Appearance) }
if ($BlueprintDir) { $a += @('--blueprint-dir', (& $full $BlueprintDir)) }
if ($DisabledPlugins) { $a += @('--disabled-plugins', $DisabledPlugins) }
if ($Headless) { $a += '--headless' }
if ($PrepareOnly) { $a += '--prepare-only' }
& $NodePath @a
exit $LASTEXITCODE
