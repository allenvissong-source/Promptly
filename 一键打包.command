#!/bin/bash
# Promptly 一键环境安装 + 打包脚本（双击运行）
# 功能：自动检测并安装 Node.js / Rust / Xcode CLT 环境，安装依赖，打包 DMG，并拷贝到桌面

cd "$(dirname "$0")" || exit 1
PROJECT_DIR="$(pwd)"

# 颜色输出
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${BLUE}▶${NC} $1"; }
ok()    { echo -e "${GREEN}✓${NC} $1"; }
warn()  { echo -e "${YELLOW}!${NC} $1"; }
err()   { echo -e "${RED}✗${NC} $1"; }

echo ""
echo "=============================================="
echo "     Promptly · 普罗  一键打包工具"
echo "=============================================="
echo ""
info "项目目录：$PROJECT_DIR"
echo ""

# ---------- 1. 检查 Xcode Command Line Tools ----------
info "[1/6] 检查 Xcode 命令行工具..."
if ! xcode-select -p >/dev/null 2>&1; then
  warn "未安装 Xcode 命令行工具，正在触发安装..."
  xcode-select --install
  echo ""
  warn "请在弹出的窗口中点击「安装」，安装完成后重新双击本脚本。"
  echo ""
  read -n 1 -s -r -p "按任意键退出..."
  exit 1
fi
ok "Xcode 命令行工具已就绪"

# ---------- 2. 检查 / 安装 Homebrew ----------
info "[2/6] 检查 Homebrew..."
if ! command -v brew >/dev/null 2>&1; then
  # Apple Silicon 默认路径
  if [ -x /opt/homebrew/bin/brew ]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [ -x /usr/local/bin/brew ]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi
fi

if ! command -v brew >/dev/null 2>&1; then
  warn "未检测到 Homebrew，正在安装（需要输入电脑密码）..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  if [ -x /opt/homebrew/bin/brew ]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [ -x /usr/local/bin/brew ]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi
fi

if command -v brew >/dev/null 2>&1; then
  ok "Homebrew 已就绪：$(brew --version | head -n 1)"
else
  err "Homebrew 安装失败，请手动安装后重试：https://brew.sh"
  read -n 1 -s -r -p "按任意键退出..."
  exit 1
fi

# ---------- 3. 检查 / 安装 Node.js ----------
info "[3/6] 检查 Node.js..."
if ! command -v node >/dev/null 2>&1; then
  warn "未检测到 Node.js，正在通过 Homebrew 安装..."
  brew install node
fi

if command -v node >/dev/null 2>&1; then
  ok "Node.js 已就绪：$(node -v)，npm：$(npm -v)"
else
  err "Node.js 安装失败，请手动安装：https://nodejs.org"
  read -n 1 -s -r -p "按任意键退出..."
  exit 1
fi

# ---------- 4. 检查 / 安装 Rust ----------
info "[4/6] 检查 Rust 工具链..."
if [ -f "$HOME/.cargo/env" ]; then
  # shellcheck disable=SC1091
  source "$HOME/.cargo/env"
fi

if ! command -v cargo >/dev/null 2>&1; then
  warn "未检测到 Rust，正在安装（约 1-3 分钟）..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path
  if [ -f "$HOME/.cargo/env" ]; then
    # shellcheck disable=SC1091
    source "$HOME/.cargo/env"
  fi
  export PATH="$HOME/.cargo/bin:$PATH"
fi

if command -v cargo >/dev/null 2>&1; then
  ok "Rust 已就绪：$(rustc --version)"
else
  err "Rust 安装失败，请手动安装：https://rustup.rs"
  read -n 1 -s -r -p "按任意键退出..."
  exit 1
fi

# 确保当前芯片架构的 target 已安装
ARCH="$(uname -m)"
if [ "$ARCH" = "arm64" ]; then
  rustup target add aarch64-apple-darwin >/dev/null 2>&1
else
  rustup target add x86_64-apple-darwin >/dev/null 2>&1
fi
ok "编译目标已就绪（当前架构：$ARCH）"

# ---------- 5. 安装前端依赖 ----------
info "[5/6] 安装项目依赖..."
if [ -d node_modules ] && [ -f package-lock.json ]; then
  ok "已存在 node_modules，执行增量安装..."
  npm install
else
  npm install
fi

if [ $? -ne 0 ]; then
  err "依赖安装失败，请检查网络后重试"
  read -n 1 -s -r -p "按任意键退出..."
  exit 1
fi
ok "项目依赖安装完成"

# ---------- 6. 执行打包 ----------
info "[6/6] 开始打包（首次编译约 3-8 分钟，请耐心等待）..."
echo ""
npm run tauri build

if [ $? -ne 0 ]; then
  echo ""
  err "打包失败，请查看上方错误信息"
  read -n 1 -s -r -p "按任意键退出..."
  exit 1
fi

# ---------- 拷贝 DMG 到桌面 ----------
echo ""
info "正在拷贝安装包到桌面..."
DMG_DIR="$PROJECT_DIR/src-tauri/target/release/bundle/dmg"
APP_DIR="$PROJECT_DIR/src-tauri/target/release/bundle/macos"
DESKTOP="$HOME/Desktop"
COPIED=0

# 拷贝 DMG
if [ -d "$DMG_DIR" ]; then
  for dmg in "$DMG_DIR"/*.dmg; do
    if [ -f "$dmg" ]; then
      cp -f "$dmg" "$DESKTOP/"
      ok "已拷贝到桌面：$(basename "$dmg")"
      COPIED=1
    fi
  done
fi

# 同时压缩一份 APP 到桌面（备用，避免 DMG 被系统标记损坏）
if [ -d "$APP_DIR/Promptly.app" ]; then
  # 清除隔离属性，避免提示「已损坏」
  xattr -cr "$APP_DIR/Promptly.app" 2>/dev/null
  rm -f "$DESKTOP/Promptly.app.zip"
  (cd "$APP_DIR" && zip -qr "$DESKTOP/Promptly.app.zip" "Promptly.app")
  ok "已拷贝到桌面：Promptly.app.zip（备用）"
  COPIED=1
fi

echo ""
echo "=============================================="
if [ "$COPIED" = "1" ]; then
  echo -e "  ${GREEN}打包完成！安装包已放到桌面${NC}"
  echo ""
  echo "  安装方式：双击 DMG → 把图标拖进「应用程序」"
  echo ""
  echo "  若提示「已损坏」，终端执行下面这行即可："
  echo "  sudo xattr -cr /Applications/Promptly.app"
else
  echo -e "  ${YELLOW}打包结束，但未找到安装包产物${NC}"
fi
echo "=============================================="
echo ""

# 打开桌面 Finder 方便查看
open "$DESKTOP" 2>/dev/null

read -n 1 -s -r -p "按任意键关闭窗口..."
echo ""
