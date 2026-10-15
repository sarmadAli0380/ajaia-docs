import { Link, Navigate, Outlet, RouterProvider, createBrowserRouter, useLocation } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth";
import { ToastProvider } from "./components/Toasts";
import { DashboardPage } from "./pages/DashboardPage";
import { EditorPage } from "./pages/EditorPage";
import { LoginPage, LogoutPage } from "./pages/LoginPage";

/** Gate for signed-in routes. A 401 anywhere sets user=null, which lands here (EC-7). */
function RequireAuth() {
  const { user, bootError, retryBoot } = useAuth();
  const location = useLocation();
  if (bootError) {
    return (
      <main className="center-page">
        <div className="panel">
          <h1>Can't connect</h1>
          <p className="muted">{bootError}</p>
          <button type="button" className="button button-primary" onClick={retryBoot}>
            Try again
          </button>
        </div>
      </main>
    );
  }
  if (user === undefined) {
    return (
      <main className="center-page">
        <p className="muted">Loading…</p>
      </main>
    );
  }
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <Outlet />;
}

function NotFoundPage() {
  return (
    <main className="center-page">
      <div className="panel">
        <h1>Page not found</h1>
        <p className="muted">There's nothing at this address.</p>
        <Link to="/" className="button button-primary">
          Go to documents
        </Link>
      </div>
    </main>
  );
}

const router = createBrowserRouter([
  { path: "/login", element: <LoginPage /> },
  { path: "/logout", element: <LogoutPage /> },
  {
    element: <RequireAuth />,
    children: [
      { path: "/", element: <DashboardPage /> },
      { path: "/documents/:id", element: <EditorPage /> },
    ],
  },
  { path: "*", element: <NotFoundPage /> },
]);

export function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </AuthProvider>
  );
}
