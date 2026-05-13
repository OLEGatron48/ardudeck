import { app } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { GazeboBridgeConfig, GazeboBridgeStatus } from '../../shared/ipc-channels.js';
import { detectPython } from '../python/python-detector.js';

const DEFAULT_CONFIG: GazeboBridgeConfig = {
  source: 'telemetry',
  output: 'udp-json',
  gazeboHost: '127.0.0.1',
  gazeboPort: 9002,
  modelName: 'ardudeck_vehicle',
  rateHz: 20,
};

function sanitizeConfig(config?: Partial<GazeboBridgeConfig>): GazeboBridgeConfig {
  const merged: GazeboBridgeConfig = {
    ...DEFAULT_CONFIG,
    ...config,
    gazeboHost: config?.gazeboHost?.trim() || DEFAULT_CONFIG.gazeboHost,
    modelName: config?.modelName?.trim() || DEFAULT_CONFIG.modelName,
    gazeboPort: Number.isFinite(config?.gazeboPort) ? Number(config!.gazeboPort) : DEFAULT_CONFIG.gazeboPort,
    rateHz: Number.isFinite(config?.rateHz) ? Number(config!.rateHz) : DEFAULT_CONFIG.rateHz,
  };

  if (merged.source === 'mavlink' && !merged.mavlinkUrl?.trim()) {
    merged.mavlinkUrl = 'tcp:127.0.0.1:5760';
  }
  if (merged.gazeboPort <= 0 || merged.gazeboPort > 65535) {
    throw new Error('Gazebo bridge port must be between 1 and 65535');
  }
  return merged;
}

function bridgeScriptPath(): string {
  const rel = path.join('resources', 'python', 'gazebo-mavlink-bridge', 'gazebo_mavlink_bridge.py');
  const candidates = [
    path.join(app.getAppPath(), rel),
    path.join(process.resourcesPath, rel),
    path.join(process.resourcesPath, 'app.asar.unpacked', rel),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(`Gazebo bridge script not found. Checked: ${candidates.join(', ')}`);
  }
  return found;
}

export interface GazeboBridgeEvents {
  on(event: 'log', listener: (level: 'info' | 'error', line: string) => void): this;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

export class GazeboBridgeManager extends EventEmitter implements GazeboBridgeEvents {
  private child: ChildProcessWithoutNullStreams | null = null;
  private currentConfig: GazeboBridgeConfig | null = null;
  private stderrBuffer = '';
  private stdoutBuffer = '';

  get isRunning(): boolean {
    return this.child !== null;
  }

  async start(config?: Partial<GazeboBridgeConfig>): Promise<{ success: boolean; error?: string }> {
    if (this.child) {
      return { success: true };
    }

    let cfg: GazeboBridgeConfig;
    try {
      cfg = sanitizeConfig(config);
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }

    const python = await detectPython();
    if (!python) {
      return {
        success: false,
        error: 'Python 3.10+ not found. Install Python or set ARDUDECK_PYTHON.',
      };
    }

    let script: string;
    try {
      script = bridgeScriptPath();
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }

    const args = [
      '-u',
      script,
      '--source', cfg.source,
      '--output', cfg.output,
      '--gazebo-host', cfg.gazeboHost,
      '--gazebo-port', String(cfg.gazeboPort),
      '--model', cfg.modelName,
      '--rate-hz', String(cfg.rateHz ?? DEFAULT_CONFIG.rateHz),
    ];
    if (cfg.source === 'mavlink') {
      args.push('--mavlink', cfg.mavlinkUrl ?? 'tcp:127.0.0.1:5760');
    }

    const child = spawn(python.path, args, {
      cwd: path.dirname(script),
      windowsHide: true,
      env: {
        PATH: process.env['PATH'] ?? '',
        SYSTEMROOT: process.env['SYSTEMROOT'] ?? '',
        TEMP: process.env['TEMP'] ?? '',
        TMP: process.env['TMP'] ?? '',
        HOME: process.env['HOME'] ?? '',
        USERPROFILE: process.env['USERPROFILE'] ?? '',
        LANG: process.env['LANG'] ?? 'en_US.UTF-8',
        PYTHONIOENCODING: 'utf-8',
        PYTHONUNBUFFERED: '1',
      },
    });

    this.child = child;
    this.currentConfig = cfg;
    this.emit('log', 'info', `[gazebo-bridge] started pid=${child.pid} source=${cfg.source}`);

    child.stdout.on('data', (chunk: Buffer) => this.handleStream('info', chunk));
    child.stderr.on('data', (chunk: Buffer) => this.handleStream('error', chunk));
    child.on('error', (error) => {
      this.emit('log', 'error', `[gazebo-bridge] spawn error: ${error.message}`);
    });
    child.on('exit', (code, signal) => {
      this.emit('log', code === 0 ? 'info' : 'error', `[gazebo-bridge] exited code=${code} signal=${signal}`);
      this.child = null;
      this.currentConfig = null;
      this.stderrBuffer = '';
      this.stdoutBuffer = '';
      this.emit('exit', code, signal);
    });

    return { success: true };
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;

    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      child.once('exit', finish);
      try {
        child.kill('SIGTERM');
      } catch {
        finish();
      }
      setTimeout(() => {
        if (this.child === child && !child.killed) {
          try {
            child.kill('SIGKILL');
          } catch {
            // ignore
          }
        }
        finish();
      }, 1500);
    });
  }

  status(): GazeboBridgeStatus {
    return {
      running: this.isRunning,
      pid: this.child?.pid,
      config: this.currentConfig ?? undefined,
    };
  }

  pushTelemetry(batch: Record<string, unknown>): void {
    if (!this.child || this.currentConfig?.source !== 'telemetry') return;
    try {
      this.child.stdin.write(`${JSON.stringify(batch)}\n`);
    } catch (error) {
      this.emit('log', 'error', `[gazebo-bridge] telemetry write failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private handleStream(level: 'info' | 'error', chunk: Buffer): void {
    const key = level === 'info' ? 'stdoutBuffer' : 'stderrBuffer';
    this[key] += chunk.toString('utf-8');
    const lines = this[key].split(/\r?\n/);
    this[key] = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim()) {
        this.emit('log', level, line.trim());
      }
    }
  }
}

export const gazeboBridgeManager = new GazeboBridgeManager();
