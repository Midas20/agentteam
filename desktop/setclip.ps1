param([string]$Png)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$img = [System.Drawing.Image]::FromFile($Png)
[System.Windows.Forms.Clipboard]::SetDataObject($img, $true)
