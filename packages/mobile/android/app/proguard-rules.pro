# R8 rules for the release build (RELEASING-MOBILE.md). Capacitor ships its own consumer rules for
# plugins; the shell's code is reached directly, not by reflection, so it needs none here.

# Readable stack traces in Play Console: mobile-release.yml uploads mapping.txt with each AAB.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
