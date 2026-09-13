import { useEffect, useRef } from 'react';

export function ScrollMascot({ pose, paused }: { pose: 'flying' | 'pointing'; paused: boolean }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mascot = ref.current;
    const section = mascot?.closest('section');
    if (!mascot || !section) return;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    let visible = false;
    let frame = 0;

    const render = () => {
      frame = 0;
      const active = visible && !paused && !reduced.matches && !document.hidden;
      const state = active ? 'active' : 'paused';
      if (mascot.dataset.motion !== state) mascot.dataset.motion = state;

      if (reduced.matches) {
        mascot.style.removeProperty('--mascot-x');
        mascot.style.removeProperty('--mascot-y');
        mascot.style.removeProperty('--mascot-tilt');
      } else if (active) {
        const bounds = section.getBoundingClientRect();

        const progress = Math.max(
          0,
          Math.min(1, (innerHeight - bounds.top) / (innerHeight + bounds.height)),
        );

        const compact = innerWidth < 1200;

        const x =
          pose === 'flying'
            ? Math.sin(progress * Math.PI) * (compact ? 24 : 52) - (compact ? 12 : 26)
            : 0;

        const y = (0.5 - progress) * (pose === 'flying' ? (compact ? 36 : 150) : 28);
        const tilt = (progress - 0.5) * (pose === 'flying' ? 24 : -10);
        mascot.style.setProperty('--mascot-x', `${x.toFixed(1)}px`);
        mascot.style.setProperty('--mascot-y', `${y.toFixed(1)}px`);
        mascot.style.setProperty('--mascot-tilt', `${tilt.toFixed(1)}deg`);
      }
    };

    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(render);
    };

    const onScroll = () => {
      if (visible && !paused && !reduced.matches && !document.hidden) schedule();
    };

    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      schedule();
    });

    observer.observe(section);
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', schedule, { passive: true });
    document.addEventListener('visibilitychange', schedule);
    reduced.addEventListener('change', schedule);
    schedule();

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', schedule);
      document.removeEventListener('visibilitychange', schedule);
      reduced.removeEventListener('change', schedule);
    };
  }, [pose, paused]);

  return (
    <div ref={ref} className={`scroll-mascot scroll-mascot-${pose}`} aria-hidden="true">
      <img
        src={`/media/beer-${pose}.webp`}
        width="480"
        height={pose === 'flying' ? 510 : 491}
        alt=""
        loading="lazy"
        decoding="async"
      />
    </div>
  );
}
