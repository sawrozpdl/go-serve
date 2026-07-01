import { useEffect, useState } from 'react';

// Reactive viewport check via matchMedia — updates on resize / rotation.
// Used to switch behavior (not just styling) between phone and desktop, e.g.
// tap-to-open sheets vs hover popovers, or where a redundant render should
// collapse to one on small screens.
export function useIsMobile(query = '(max-width: 640px)') {
  const [match, setMatch] = useState(
    () => typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(query).matches,
  );
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia(query);
    const onChange = () => setMatch(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return match;
}
