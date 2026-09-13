import { Layer, ManagedRuntime } from 'effect';
import { Auth } from '../auth/service';
import { Infrastructure } from './resources';
import { WorkersLive } from './jobs';

export function createRuntime() {
  const application = Layer.merge(Auth.layer, WorkersLive).pipe(
    Layer.provideMerge(Infrastructure.layer),
  );
  return ManagedRuntime.make(application);
}
