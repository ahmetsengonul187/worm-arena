$code = Get-Content -Raw "game.js"
$openC = ($code.ToCharArray() | Where-Object { $_ -eq '{' }).Count
$closeC = ($code.ToCharArray() | Where-Object { $_ -eq '}' }).Count
$openP = ($code.ToCharArray() | Where-Object { $_ -eq '(' }).Count
$closeP = ($code.ToCharArray() | Where-Object { $_ -eq ')' }).Count
$openB = ($code.ToCharArray() | Where-Object { $_ -eq '[' }).Count
$closeB = ($code.ToCharArray() | Where-Object { $_ -eq ']' }).Count

Write-Host "Curly braces: $openC open, $closeC close (diff: $($openC - $closeC))"
Write-Host "Parentheses: $openP open, $closeP close (diff: $($openP - $closeP))"
Write-Host "Square brackets: $openB open, $closeB close (diff: $($openB - $closeB))"
