import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from './components/ui/sonner';
import { AuthProvider } from './context/AuthContext';
import ProtectedRoute from './components/ProtectedRoute';
import Landing from './pages/Landing';
import About from './pages/About';
import Contact from './pages/Contact';
import Pricing from './pages/Pricing';
import PayMethod from './pages/PayMethod';
import PayManual from './pages/PayManual';
import PayPalReturn from './pages/PayPalReturn';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';
import ReferralLanding from './pages/ReferralLanding';
import MyReferral from './pages/MyReferral';
import Login from './pages/Login';
import Register from './pages/Register';
import Verify2FA from './pages/Verify2FA';
import Setup2FA from './pages/Setup2FA';
import Dashboard from './pages/Dashboard';
import BillingSuccess from './pages/BillingSuccess';
import Operator from './pages/Operator';
import ProjectSettings from './pages/ProjectSettings';
import MarketingBanner from './components/MarketingBanner';
import PersonalUseBanner from './components/PersonalUseBanner';
import './App.css';

function App() {
  return (
    <div className="App min-h-screen bg-background text-foreground">
      <AuthProvider>
        <BrowserRouter>
          <MarketingBanner />
          <PersonalUseBanner />
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/about" element={<About />} />
            <Route path="/contact" element={<Contact />} />
            <Route path="/pricing" element={<Pricing />} />
            <Route path="/pay" element={<ProtectedRoute><PayMethod /></ProtectedRoute>} />
            <Route path="/pay/manual" element={<ProtectedRoute><PayManual /></ProtectedRoute>} />
            <Route path="/pay/paypal/return" element={<ProtectedRoute><PayPalReturn /></ProtectedRoute>} />
            <Route path="/pay/paypal/cancel" element={<Navigate to="/pricing" replace />} />
            <Route path="/referral/:code" element={<ReferralLanding />} />
            <Route path="/refer" element={<ProtectedRoute><MyReferral /></ProtectedRoute>} />
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />
            <Route path="/forgot-password" element={<ForgotPassword />} />
            <Route path="/reset-password" element={<ResetPassword />} />
            <Route path="/verify-2fa" element={<Verify2FA />} />
            <Route path="/setup-2fa" element={<ProtectedRoute><Setup2FA /></ProtectedRoute>} />
            <Route path="/dashboard" element={<ProtectedRoute><Dashboard variant="tbc1" /></ProtectedRoute>} />
            <Route path="/dashboard/:sessionId" element={<ProtectedRoute><Dashboard variant="tbc1" /></ProtectedRoute>} />
            <Route path="/tbc2" element={<ProtectedRoute><Dashboard variant="tbc2" /></ProtectedRoute>} />
            <Route path="/tbc2/:sessionId" element={<ProtectedRoute><Dashboard variant="tbc2" /></ProtectedRoute>} />
            <Route path="/billing/success" element={<ProtectedRoute><BillingSuccess /></ProtectedRoute>} />
            <Route path="/operator" element={<ProtectedRoute operatorOnly><Operator /></ProtectedRoute>} />
            <Route path="/operator/projects/:projectId/settings" element={<ProtectedRoute operatorOnly><ProjectSettings /></ProtectedRoute>} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
        <Toaster position="top-right" theme="dark" richColors />
      </AuthProvider>
    </div>
  );
}

export default App;
