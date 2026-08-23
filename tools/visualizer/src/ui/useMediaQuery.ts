import { useEffect, useState } from 'react';

function matches(query: string): boolean {
  return typeof matchMedia === 'function' && matchMedia(query).matches;
}

export function useMediaQuery(query: string): boolean {
  const [active, setActive] = useState(() => matches(query));

  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const list = matchMedia(query);
    setActive(list.matches);
    const listen = (event: MediaQueryListEvent) => setActive(event.matches);
    list.addEventListener('change', listen);
    return () => list.removeEventListener('change', listen);
  }, [query]);

  return active;
}
