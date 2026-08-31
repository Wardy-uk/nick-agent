import { useCallback, useState } from 'react';
import * as api from './api';
import SignIn from './views/SignIn.jsx';
import Home from './views/Home.jsx';

/**
 * VESTA — the shared home surface. Nick's is SARA; this one is the household's.
 *
 * Two screens and no router: sign in, or home. There is nothing else to
 * navigate to, and a menu on a four-block fridge-door screen is furniture.
 */
export default function App() {
  // A token in storage is a resumed session, not a verified one — `/home`
  // decides, and a 401 there drops straight back here.
  const [session, setSession] = useState(() => (api.getToken() ? { resumed: true } : null));

  const signOut = useCallback(() => {
    api.clearToken();
    setSession(null);
  }, []);

  return (
    <div className="app">
      {session
        ? <Home onSignedOut={signOut} />
        : <SignIn onSignedIn={setSession} />}
    </div>
  );
}
