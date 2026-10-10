import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { useCursorGlow } from './motion';

type PanelProps = HTMLAttributes<HTMLElement> & { as?: 'section' | 'main' | 'aside' | 'div'; children: ReactNode };

/** A rounded surface with a soft cursor light and an edge that catches the pointer. */
export const Panel = forwardRef<HTMLElement, PanelProps>(function Panel({ as = 'section', className = '', children, onMouseMove, onMouseLeave, ...rest }, ref) {
  const glow = useCursorGlow();
  const Tag = as;
  return <Tag ref={ref as never} className={`panel ${className}`} {...rest}
    onMouseMove={(e: React.MouseEvent<HTMLElement>) => { glow.onMouseMove(e); onMouseMove?.(e); }}
    onMouseLeave={(e: React.MouseEvent<HTMLElement>) => { glow.onMouseLeave(); onMouseLeave?.(e); }}>
    <div ref={glow.glowRef} className="panel-glow" aria-hidden="true" />
    <div ref={glow.edgeRef} className="edge" aria-hidden="true" />
    {children}
  </Tag>;
});
