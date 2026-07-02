' Start de P1 push-brug verborgen (geen zichtbaar console-venster).
' Aangeroepen door de scheduled task "EnergieP1PushBrug" bij inloggen.
CreateObject("Wscript.Shell").Run """C:\Weppas\projects\energie-tool\p1-push-start.bat""", 0, False
