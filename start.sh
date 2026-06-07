#!/bin/bash
echo "🚀 TrackDown Bot başladılır..."

cd "$(dirname "$0")"

# Kill old tmux sessions
tmux kill-session -t bot 2>/dev/null
tmux kill-session -t tunnel 2>/dev/null
sleep 1

# Start bot in tmux
tmux new-session -d -s bot 'node index.js'
sleep 5

# Start localhost.run tunnel (no warning page!)
tmux new-session -d -s tunnel 'ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -R 80:localhost:3000 nokey@localhost.run 2>&1'
sleep 8

# Get the tunnel URL
TMUX_OUT=$(tmux capture-pane -t tunnel -p -S -15 2>&1)
LH_URL=$(echo "$TMUX_OUT" | grep -oP 'https://[a-zA-Z0-9]+\.lhr\.life' | head -1)
echo "✅ Bot işləyir!"
echo "   Telegram: @streamogbot"
echo "   Public URL: $LH_URL"
echo ""

# Update bot.js with new URL
cat > bot.js << EOF
module.exports = {
  token:  "8286423335:AAH1f5I4NM7B5nmJtEL7i-hCt5Umms7Aj_8",
  domain: "$LH_URL"
};
EOF

# Restart bot with new domain
tmux kill-session -t bot 2>/dev/null
sleep 1
tmux new-session -d -s bot 'node index.js'
sleep 5

echo ""
tmux capture-pane -t bot -p -S -8 2>&1 | grep -E "Token|Domain|Port|Server"
echo ""
echo "⚠️  Qeyd: Bu URL keçicidir. Hər restartda dəyişir."
