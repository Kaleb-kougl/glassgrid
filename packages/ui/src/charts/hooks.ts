import { useEffect, useLayoutEffect, useState, type RefObject } from 'react';

/** Bumps once the webfonts are in (and on later font loads) so canvas text is re-measured. */
export function useFontsVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const fonts: FontFaceSet | undefined = (document as Partial<Pick<Document, 'fonts'>>).fonts;
    if (!fonts) return;
    const bump = () => setVersion((v) => v + 1);
    void fonts.ready.then(bump);
    fonts.addEventListener('loadingdone', bump);
    return () => fonts.removeEventListener('loadingdone', bump);
  }, []);
  return version;
}

/** The content width of an element (CSS px), kept current with a ResizeObserver. */
export function useElementWidth(ref: RefObject<HTMLElement | null>, fallback = 0): number {
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setWidth(element.clientWidth || fallback);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, fallback]);
  return width;
}
