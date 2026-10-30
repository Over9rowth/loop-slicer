import { spawn } from 'node:child_process';
import electronPath from 'electron';

const root = process.cwd();
// 本机（无显卡直通的沙箱/远程桌面环境）里 GPU 进程会连续崩溃，报
// "GPU process isn't usable. Goodbye." 并把渲染进程一起带崩，冒烟无法跑完。
// 应用本身已 disableHardwareAcceleration（见 src/main/index.ts：硬件合成下
// MediaRecorder 会静默产出 0 字节），这里再显式关掉 GPU 进程，让冒烟在纯软件
// 渲染下跑完。只影响本机自动化，用户机不会带这些参数。
const args = [
  '.',
  '--smoke',
  '--no-sandbox',
  '--disable-gpu',
  '--disable-gpu-sandbox',
  '--in-process-gpu',
];
const child = spawn(electronPath, args, {
  cwd: root,
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
  stdio: 'inherit',
});
child.on('exit', (code) => {
  if (code === 0) console.log('SMOKE PASS');
  process.exit(code ?? 1);
});
