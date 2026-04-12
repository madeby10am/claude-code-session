import { vi } from 'vitest';

export const workspace = {
  onDidChangeTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
};

export const window = {
  createWebviewPanel: vi.fn(),
  onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
};

export const Uri = {
  joinPath: vi.fn((_base: unknown, ...parts: string[]) => ({ path: parts.join('/') })),
};

export enum ViewColumn { Two = 2 }
