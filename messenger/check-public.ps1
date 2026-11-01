# Проверка живого чата на Render через .NET ClientWebSocket (TLS Windows)
param([string]$Host_ = "local-messenger-xtfd.onrender.com", [string]$Pass = "")
$ErrorActionPreference = "Stop"
$proof = ""
if ($Pass) {
  $sha = [Security.Cryptography.SHA256]::Create()
  $proof = -join ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Pass)) | ForEach-Object { $_.ToString("x2") })
}

function New-Chat([string]$nick) {
  $ws = [System.Net.WebSockets.ClientWebSocket]::new()
  $ws.ConnectAsync([Uri]"wss://$Host_", [Threading.CancellationToken]::None).GetAwaiter().GetResult()
  $msg = @{ type = "join"; nick = $nick; proof = $proof } | ConvertTo-Json -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($msg)
  $ws.SendAsync([ArraySegment[byte]]::new($bytes), [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
  return $ws
}

function Receive-Json($ws, $timeoutSec = 10) {
  $buf = New-Object byte[] 65536
  $cts = [Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds($timeoutSec))
  $res = $ws.ReceiveAsync([ArraySegment[byte]]::new($buf), $cts.Token).GetAwaiter().GetResult()
  if ($res.Count -eq 0) { return $null }
  return [Text.Encoding]::UTF8.GetString($buf, 0, $res.Count) | ConvertFrom-Json
}

$a = New-Chat "Проверка1"
$welcomeA = Receive-Json $a
$b = New-Chat "Проверка2"
$welcomeB = Receive-Json $b

$payload = @{ type = "msg"; text = "живой чат на Render 🚀" } | ConvertTo-Json -Compress
$pb = [Text.Encoding]::UTF8.GetBytes($payload)
$b.SendAsync([ArraySegment[byte]]::new($pb), [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
Start-Sleep -Milliseconds 800

$delivered = $false; $presence = $false
for ($i = 0; $i -lt 6; $i++) {
  $m = Receive-Json $a 3
  if ($null -eq $m) { break }
  if ($m.type -eq "msg" -and $m.msg.text -like "*живой чат*") { $delivered = $true }
  if ($m.type -eq "presence") { $presence = $true }
  if ($m.type -eq "system" -and $delivered) { }
  if ($delivered -and $presence) { break }
}

# неверный пароль должен отбиваться
$rejected = $false
try {
  $badProof = "deadbeef" * 8
  $c = [System.Net.WebSockets.ClientWebSocket]::new()
  $c.ConnectAsync([Uri]"wss://$Host_", [Threading.CancellationToken]::None).GetAwaiter().GetResult()
  $m = @{ type = "join"; nick = "Злой"; proof = $badProof } | ConvertTo-Json -Compress
  $bb = [Text.Encoding]::UTF8.GetBytes($m)
  $c.SendAsync([ArraySegment[byte]]::new($bb), [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
  $r = Receive-Json $c 6
  if ($r -and $r.type -eq "error") { $rejected = $true }
  $c.Dispose()
} catch { $rejected = $true }

$a.Dispose(); $b.Dispose()

[pscustomobject]@{
  connect = ($null -ne $welcomeA -and $null -ne $welcomeB)
  nicks = @($welcomeA.you.nick, $welcomeB.you.nick)
  delivered = $delivered
  presence = $presence
  badAuthRejected = $rejected
} | ConvertTo-Json
