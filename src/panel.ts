import * as vscode from 'vscode';
import { AnimationState } from './stateManager';

export class Panel {
  private static instance: Panel | undefined;
  private readonly panel: vscode.WebviewPanel;

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly onAnimationDone: (state: AnimationState) => void,
    private readonly onClose: () => void
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'pixelAgent',
      '🧑‍💻 Dev',
      { viewColumn: vscode.ViewColumn.Two, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, 'assets'),
        ],
      }
    );

    this.panel.webview.html = this.buildHtml();

    this.panel.webview.onDidReceiveMessage((msg: { type: string; state: string }) => {
      if (msg.type === 'animationDone') {
        this.onAnimationDone(msg.state as AnimationState);
      }
    });

    this.panel.onDidDispose(() => {
      Panel.instance = undefined;
      this.onClose();
    });
  }

  static create(
    context: vscode.ExtensionContext,
    onAnimationDone: (state: AnimationState) => void,
    onClose: () => void
  ): Panel {
    if (!Panel.instance) {
      Panel.instance = new Panel(context, onAnimationDone, onClose);
    }
    return Panel.instance;
  }

  static getInstance(): Panel | undefined {
    return Panel.instance;
  }

  setState(state: AnimationState): void {
    this.panel.webview.postMessage({ type: 'setState', state });
  }

  dispose(): void {
    this.panel.dispose(); // onDidDispose fires synchronously and clears Panel.instance
  }

  private uri(rel: string): string {
    return this.panel.webview
      .asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, rel))
      .toString();
  }

  private buildHtml(): string {
    const t  = this.uri('assets/sprites/typing.png');
    const d  = this.uri('assets/sprites/drinking.png');
    const lb = this.uri('assets/sprites/leaning.png');
    const st = this.uri('assets/sprites/stretching.png');
    const w  = this.uri('assets/sprites/walking.png');
    const sl = this.uri('assets/sprites/sleeping.png');
    const csp = this.panel.webview.cspSource;

    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; img-src ${csp} data:; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body {
  width:200px; height:200px; overflow:hidden;
  background:#0d0d1a;
  display:flex; align-items:flex-end; justify-content:center;
  padding-bottom:12px;
}
#c {
  width:64px; height:64px;
  image-rendering:pixelated;
  background-repeat:no-repeat;
  background-size:auto 64px;
}
[data-state="typing"] #c {
  background-image:url('${t}');
  animation:at 0.5s steps(4) infinite;
}
@keyframes at { from{background-position:0 0} to{background-position:-256px 0} }

[data-state="drinking_coffee"] #c {
  background-image:url('${d}');
  animation:ad 1.5s steps(6) 1 forwards;
}
@keyframes ad { from{background-position:0 0} to{background-position:-384px 0} }

[data-state="leaning_back"] #c {
  background-image:url('${lb}');
  animation:al 1.5s steps(3) infinite;
}
@keyframes al { from{background-position:0 0} to{background-position:-192px 0} }

[data-state="stretching"] #c {
  background-image:url('${st}');
  animation:as 2s steps(6) 1 forwards;
}
@keyframes as { from{background-position:0 0} to{background-position:-384px 0} }

[data-state="walking"] #c {
  background-image:url('${w}');
  animation:aw 0.75s steps(6) infinite;
}
@keyframes aw { from{background-position:0 0} to{background-position:-384px 0} }

[data-state="sleeping"] #c {
  background-image:url('${sl}');
  animation:asl 4s steps(2) infinite;
}
@keyframes asl { from{background-position:0 0} to{background-position:-128px 0} }
</style>
</head>
<body data-state="typing">
<div id="c"></div>
<script>
const vscode = acquireVsCodeApi();
const el = document.getElementById('c');
window.addEventListener('message', e => {
  if (e.data.type === 'setState') {
    document.body.setAttribute('data-state', e.data.state);
  }
});
el.addEventListener('animationend', () => {
  const s = document.body.getAttribute('data-state');
  if (s === 'drinking_coffee' || s === 'stretching') {
    vscode.postMessage({ type: 'animationDone', state: s });
  }
});
</script>
</body>
</html>`;
  }
}
