import type { Ora } from 'ora';
import chalk from 'chalk';
import type { EventPort, AgentEvent } from '@cezar/core';

/**
 * EventPort impl that routes lifecycle messages to an ora spinner, promotes
 * certain milestone events to permanent log lines, and forwards agent events
 * to a verbose handler.
 */
export class ConsoleEventAdapter implements EventPort {
  private readonly permanentLogPatterns: RegExp[];

  constructor(
    private readonly spinner: Ora,
    private readonly onAgent?: (event: AgentEvent) => void,
    permanentLogPatterns: RegExp[] = [
      /] Attempt \d+\/\d+ /,
      /] review failed — retrying/,
      /] DRY-RUN /,
      /] PUSH /,
      /] PR /,
      /] DONE /,
    ],
  ) {
    this.permanentLogPatterns = permanentLogPatterns;
  }

  lifecycle(message: string): void {
    if (this.permanentLogPatterns.some((re) => re.test(message))) {
      this.spinner.clear();
      process.stdout.write(`  ${chalk.dim(message)}\n`);
      this.spinner.render();
    } else {
      this.spinner.text = message;
    }
  }

  agent(event: AgentEvent): void {
    this.onAgent?.(event);
  }

  progress(phase: number, current: number, total: number): void {
    this.spinner.text = `Phase ${phase}: ${current}/${total}`;
  }
}
