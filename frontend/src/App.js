import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from './components/ui/sonner';
import { AuthProvider } from './context/AuthContext';
import ProtectedRoute from './components/ProtectedRoute';
import Landing from './pages/Landing';
import About from './pages/About';
import Contact from './pages/Contact';
import Pricing from './pages/Pricing';
import Login from './pages/Login';
import Register from './pages/Register';
import Verify2FA from './pages/Verify2FA';
import Setup2FA from './pages/Setup2FA';
import Dashboard from './pages/Dashboard';
import BillingSuccess from './pages/BillingSuccess';
import Operator from './pages/Operator';
import './App.css';

function App() {
  return (
    <div className="App min-h-screen bg-background text-foreground">
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/about" element={<About />} />
            <Route path="/contact" element={<Contact />} />
            <Route path="/pricing" element={<Pricing />} />
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />
            <Route path="/verify-2fa" element={<Verify2FA />} />
            <Route path="/setup-2fa" element={<ProtectedRoute><Setup2FA /></ProtectedRoute>} />
            <Route path="/dashboard" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
            <Route path="/dashboard/:sessionId" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
            <Route path="/billing/success" element={<ProtectedRoute><BillingSuccess /></ProtectedRoute>} />
            <Route path="/operator" element={<ProtectedRoute operatorOnly><Operator /></ProtectedRoute>} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
        <Toaster position="top-right" theme="dark" richColors />
      </AuthProvider>
    </div>
  );
}

export default App;
