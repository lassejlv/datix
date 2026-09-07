import { useLayoutEffect, type ReactNode } from 'react';
import { useAnimate } from 'motion/react-mini';

/** Animate the new view without retaining old controls or remounting forms. */
export function PageTransition({
  view,
  children,
  className,
}: {
  view: string;
  children: ReactNode;
  className?: string;
}) {
  const [scope, animate] = useAnimate<HTMLDivElement>();

  useLayoutEffect(() => {
    const element = scope.current;
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (!element || preference.matches) return;
    const animation = animate(
      element,
      { opacity: [0, 1], transform: ['translateY(6px)', 'translateY(0px)'] },
      { duration: 0.18, ease: [0.22, 1, 0.36, 1] },
    );
    const stop = () => {
      animation.stop();
      element.style.removeProperty('opacity');
      element.style.removeProperty('transform');
    };
    const preferenceChanged = () => {
      if (preference.matches) stop();
    };
    preference.addEventListener('change', preferenceChanged);
    return () => {
      preference.removeEventListener('change', preferenceChanged);
      stop();
    };
  }, [view, scope, animate]);

  return (
    <div ref={scope} className={className} data-page-transition={view}>
      {children}
    </div>
  );
}
