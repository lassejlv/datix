import { motion, useReducedMotion } from 'motion/react';

/** A shared background/underline that follows the current selection. */
export function SelectionIndicator({ id, className }: { id: string; className: string }) {
  const reduceMotion = useReducedMotion();
  return (
    <motion.span
      aria-hidden="true"
      data-selection-indicator=""
      className={className}
      layoutId={id}
      initial={false}
      transition={{ type: 'tween', duration: reduceMotion ? 0 : 0.26, ease: [0.19, 1, 0.22, 1] }}
    />
  );
}
