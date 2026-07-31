const Jimp = require('jimp');

async function createDmgBackground() {
  const W = 660;
  const H = 400;

  // 创建画布
  const img = new Jimp(W, H, 0xFFF5F5F7); // 浅灰色背景

  // 顶部标题栏背景
  for (let y = 15; y < 60; y++) {
    for (let x = 20; x < W - 20; x++) {
      img.setPixelColor(0xFF1C1C1E, x, y);
    }
  }

  // 中间面板背景（白色）
  for (let y = 90; y < 310; y++) {
    for (let x = 80; x < W - 80; x++) {
      img.setPixelColor(0xFFFFFFFF, x, y);
    }
  }

  // 左侧应用图标位置提示框
  for (let y = 106; y < 234; y++) {
    for (let x = 116; x < 244; x++) {
      img.setPixelColor(0xFFF2F2F7, x, y);
    }
  }

  // 右侧 Applications 文件夹位置提示框
  for (let y = 106; y < 234; y++) {
    for (let x = 416; x < 544; x++) {
      img.setPixelColor(0xFFF2F2F7, x, y);
    }
  }

  // 绘制箭头（从左侧指向右侧）
  const arrowY = 170;
  const arrowStartX = 244;
  const arrowEndX = 416;
  const arrowColor = 0xFF007AFF;

  // 箭头主体线
  for (let x = arrowStartX; x < arrowEndX; x++) {
    for (let dy = -2; dy <= 2; dy++) {
      img.setPixelColor(arrowColor, x, arrowY + dy);
    }
  }

  // 箭头头部（三角形）
  for (let dx = 0; dx < 14; dx++) {
    const width = Math.max(1, Math.floor((14 - dx) / 2));
    for (let dy = -width; dy <= width; dy++) {
      img.setPixelColor(arrowColor, arrowEndX - dx, arrowY + dy);
    }
  }

  // 加载字体并添加文字
  const fontLarge = await Jimp.loadFont(Jimp.FONT_SANS_32_WHITE);
  const fontMedium = await Jimp.loadFont(Jimp.FONT_SANS_16_BLACK);
  const fontSmall = await Jimp.loadFont(Jimp.FONT_SANS_10_BLACK);
  const fontHint = await Jimp.loadFont(Jimp.FONT_SANS_8_BLACK);

  // 标题
  img.print(fontLarge, 0, 20, {
    text: 'Promptly',
    alignmentX: Jimp.HORIZONTAL_ALIGN_CENTER
  }, W, 40);

  // 应用图标标签
  img.print(fontSmall, 0, 240, {
    text: 'Promptly',
    alignmentX: Jimp.HORIZONTAL_ALIGN_CENTER
  }, 360, 20);

  // Applications 文件夹标签
  img.print(fontSmall, 300, 240, {
    text: 'Applications',
    alignmentX: Jimp.HORIZONTAL_ALIGN_CENTER
  }, 360, 20);

  // 底部说明文字
  img.print(fontMedium, 0, 335, {
    text: 'Drag Promptly to Applications to install',
    alignmentX: Jimp.HORIZONTAL_ALIGN_CENTER
  }, W, 30);

  // 底部小提示
  img.print(fontHint, 0, 365, {
    text: 'If security warning: System Settings > Privacy & Security > Open Anyway',
    alignmentX: Jimp.HORIZONTAL_ALIGN_CENTER
  }, W, 20);

  await img.writeAsync('./src-tauri/dmg-background.png');
  console.log('DMG background created: ./src-tauri/dmg-background.png');
}

createDmgBackground().catch(console.error);
