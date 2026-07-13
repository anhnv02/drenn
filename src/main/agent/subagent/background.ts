import { EventEmitter } from 'events';

export type BackgroundJobStatus = 'running' | 'completed' | 'error' | 'cancelled';

export interface BackgroundJob {
  id: string;
  sessionId: string;
  status: BackgroundJobStatus;
  output?: string;
  error?: string;
  startTime: number;
  endTime?: number;
  background: boolean;
}

export interface BackgroundJobResult {
  info: BackgroundJob;
}

export class BackgroundJobService extends EventEmitter {
  private jobs = new Map<string, BackgroundJob>();
  private waiters = new Map<
    string,
    Array<{
      resolve: (result: BackgroundJobResult) => void;
      reject: (error: Error) => void;
    }>
  >();

  start(jobId: string, sessionId: string, background = false): BackgroundJob {
    const job: BackgroundJob = {
      id: jobId,
      sessionId,
      status: 'running',
      startTime: Date.now(),
      background,
    };
    this.jobs.set(jobId, job);
    return job;
  }

  complete(jobId: string, output: string): void {
    const job = this.jobs.get(jobId);
    if (job) {
      job.status = 'completed';
      job.output = output;
      job.endTime = Date.now();
      this.notifyWaiters(jobId);
      this.emit('settled', job);
    }
  }

  error(jobId: string, error: string): void {
    const job = this.jobs.get(jobId);
    if (job) {
      job.status = 'error';
      job.error = error;
      job.endTime = Date.now();
      this.notifyWaiters(jobId);
      this.emit('settled', job);
    }
  }

  cancel(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (job) {
      job.status = 'cancelled';
      job.endTime = Date.now();
      this.notifyWaiters(jobId);
      this.emit('settled', job);
    }
  }

  get(jobId: string): BackgroundJob | undefined {
    return this.jobs.get(jobId);
  }

  getBySession(sessionId: string): BackgroundJob | undefined {
    for (const job of this.jobs.values()) {
      if (job.sessionId === sessionId) {
        return job;
      }
    }
    return undefined;
  }

  async wait(jobId: string): Promise<BackgroundJobResult> {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Job ${jobId} not found`);
    }

    if (job.status !== 'running') {
      return { info: job };
    }

    return new Promise<BackgroundJobResult>((resolve, reject) => {
      const waiters = this.waiters.get(jobId) || [];
      waiters.push({ resolve, reject });
      this.waiters.set(jobId, waiters);
    });
  }

  private notifyWaiters(jobId: string): void {
    const job = this.jobs.get(jobId);
    const waiters = this.waiters.get(jobId);
    if (job && waiters) {
      for (const waiter of waiters) {
        waiter.resolve({ info: job });
      }
      this.waiters.delete(jobId);
    }
  }

  list(): BackgroundJob[] {
    return Array.from(this.jobs.values());
  }

  clear(): void {
    this.jobs.clear();
    this.waiters.clear();
  }
}

export const backgroundJobService = new BackgroundJobService();
