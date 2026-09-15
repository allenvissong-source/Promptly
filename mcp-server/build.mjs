// 把 server 打包成单个 .mjs，供 Tauri 作为资源随 App 分发。
//
// 为什么要打包而不是直接带 src + node_modules：
//   - node_modules 装完是 34MB（其中 esbuild 自己就占 10MB），而打包产物不到 1MB；
//   - 打包后运行时只需要 node 本身，不需要 tsx / esbuild，少一层可能出错的环节；
//   - src 里 import 了 ../../src 下的前端模块，直接带 src 就还得把前端源码一起
//     塞进安装包，打包能把那部分一起内联掉。
//
// 产物落在 mcp-server/dist-bundle/server.mjs，由 tauri.conf.json 的 bundle.resources
// 带进 App。

import { build } from 'esbuild';
import { mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const outDir = join(root, 'dist-bundle');
const outFile = join(outDir, 'server.mjs');

mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [join(root, 'src/index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: outFile,
  // node: 内置模块保持外部引用，其余全部内联。
  external: ['node:*'],
  // 保留可读的函数名，出错时堆栈还能看懂；体积差异不大。
  minify: false,
  banner: {
    js: '// 由 mcp-server/build.mjs 生成，请勿手改。改动请修改 src/ 后重新构建。',
  },
});

const size = statSync(outFile).size;
console.log(`已生成 ${outFile}`);
console.log(`体积 ${(size / 1024).toFixed(0)} KB`);
