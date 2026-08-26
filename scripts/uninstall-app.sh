#!/bin/zsh
# Stops the background dbweb server and removes the LaunchAgent.
# (Deleting the installed Chrome app itself: chrome://apps → right-click → Remove.)
LABEL="com.dbweb.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
rm -rf "$HOME/Applications/dbweb.app"
echo "Removed $LABEL + the launcher app. Data in ~/.dbweb is untouched."
