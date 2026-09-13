import * as Layer from 'effect/Layer';
import * as ManagedRuntime from 'effect/ManagedRuntime';
import { Infrastructure } from './resources';
import { readConfig } from './config';

export async function createRuntime() {
  const config = readConfig();
  const infrastructure = Infrastructure.layer(config);

  if (config.role === 'worker') {
    const { WorkersLive } = await import('./jobs');

    return {
      role: config.role,
      runtime: ManagedRuntime.make(WorkersLive.pipe(Layer.provideMerge(infrastructure))),
    } as const;
  }

  const { Auth } = await import('../auth/service');

  if (config.role === 'api')
    return {
      role: config.role,
      runtime: ManagedRuntime.make(Auth.layer.pipe(Layer.provideMerge(infrastructure))),
    } as const;

  const { WorkersLive } = await import('./jobs');

  const application = Layer.merge(Auth.layer, WorkersLive).pipe(Layer.provideMerge(infrastructure));

  return { role: config.role, runtime: ManagedRuntime.make(application) } as const;
}
