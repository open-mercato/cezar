cask "cezar" do
  version "0.1.11"

  on_arm do
    sha256 "f80eaa568daa9ca0224c3a5faa1815fcd0131b166a441b04702ff4818ca631f5"

    url "https://github.com/open-mercato/cezar/releases/download/desktop-v#{version}/cezar-macos-aarch64.dmg"
  end
  on_intel do
    sha256 "0f418dc9efa0575ad090f35a12e5a5afa7f75590d551fb9a2b1894ca6a7ae30f"

    url "https://github.com/open-mercato/cezar/releases/download/desktop-v#{version}/cezar-macos-x86_64.dmg"
  end

  name "Cezar"
  desc "Local cockpit for AI coding agents"
  homepage "https://github.com/open-mercato/cezar"

  livecheck do
    url :url
    regex(/^desktop-v?(\d+(?:\.\d+)+)$/i)
    strategy :github_releases
  end

  auto_updates true
  depends_on macos: :monterey

  app "Cezar.app"

  # ~/.cezar is shared with the cezar CLI (projects, managers, accounts), so only the files the
  # desktop app alone owns there are removed.
  zap trash: [
    "~/.cezar/desktop-notch.json",
    "~/.cezar/desktop-window.json",
    "~/.cezar/node",
    "~/Library/Application Support/com.openmercato.cezar",
    "~/Library/Caches/com.openmercato.cezar",
    "~/Library/HTTPStorages/com.openmercato.cezar",
    "~/Library/Logs/com.openmercato.cezar",
    "~/Library/Preferences/com.openmercato.cezar.plist",
    "~/Library/Saved Application State/com.openmercato.cezar.savedState",
    "~/Library/WebKit/com.openmercato.cezar",
  ]
end
