export type AnimationState =
  | 'typing'
  | 'drinking_coffee'
  | 'leaning_back'
  | 'stretching'
  | 'walking'
  | 'sleeping';

const IDLE_30S     =  30_000;
const IDLE_5MIN    =   5 * 60_000;
const IDLE_10MIN   =  10 * 60_000;
const TYPING_15MIN =  15 * 60_000;

export class StateManager {
  private current: AnimationState = 'typing';
  private idleTimer:     ReturnType<typeof setTimeout> | null = null;
  private longIdleTimer: ReturnType<typeof setTimeout> | null = null;
  private typingTimer:   ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly onStateChange: (state: AnimationState) => void) {}

  getCurrent(): AnimationState {
    return this.current;
  }

  onKeypress(): void {
    this.clearTimers();
    this.transitionTo('typing');
    this.startIdleChain();
    this.startTypingTimer();
  }

  onAnimationDone(): void {
    if (this.current === 'drinking_coffee') {
      this.transitionTo('leaning_back');
      this.startLongIdleChain();
    } else if (this.current === 'stretching') {
      this.transitionTo('typing');
      this.startIdleChain();
      this.startTypingTimer();
    }
  }

  onClaudeActive(): void {
    if (this.current !== 'typing' && this.current !== 'stretching') {
      this.transitionTo('leaning_back');
    }
  }

  onClaudeIdle(): void {
    // No transition — idle chain already running from previous state
  }

  dispose(): void {
    this.clearTimers();
  }

  private transitionTo(next: AnimationState): void {
    if (next === this.current) return;
    this.current = next;
    this.onStateChange(next);
  }

  private startIdleChain(): void {
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.transitionTo('drinking_coffee');
      // leaning_back triggered by onAnimationDone after drink completes
    }, IDLE_30S);
  }

  private startLongIdleChain(): void {
    this.longIdleTimer = setTimeout(() => {
      this.transitionTo('walking');
      this.longIdleTimer = setTimeout(() => {
        this.transitionTo('sleeping');
        this.longIdleTimer = null;
      }, IDLE_10MIN);
    }, IDLE_5MIN);
  }

  private startTypingTimer(): void {
    if (this.typingTimer) clearTimeout(this.typingTimer);
    this.typingTimer = setTimeout(() => {
      this.typingTimer = null;
      // Cancel idle timer so it doesn't interfere — typing session takes priority
      if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
      this.transitionTo('stretching');
    }, TYPING_15MIN);
  }

  private clearTimers(): void {
    if (this.idleTimer)     { clearTimeout(this.idleTimer);     this.idleTimer     = null; }
    if (this.longIdleTimer) { clearTimeout(this.longIdleTimer); this.longIdleTimer = null; }
    if (this.typingTimer)   { clearTimeout(this.typingTimer);   this.typingTimer   = null; }
  }
}
