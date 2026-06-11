import React, { useState } from 'react';
import Navbar from '../components/Navbar';
import Footer from '../components/Footer';
import api from '../lib/api';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import { toast } from 'sonner';
import { Mail, MapPin, Phone, Send, Loader2 } from 'lucide-react';

export default function Contact() {
  const [form, setForm] = useState({ name: '', email: '', subject: '', message: '' });
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!form.name || !form.email || !form.message) {
      toast.error('Please fill name, email and message');
      return;
    }
    setSubmitting(true);
    try {
      await api.post('/contact', form);
      toast.success('Thanks! We\u2019ll get back to you soon.');
      setForm({ name: '', email: '', subject: '', message: '' });
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Submission failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950">
      <Navbar />
      <section className="mx-auto max-w-6xl px-5 py-20">
        <div className="grid gap-12 md:grid-cols-2">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-400">Get in touch</div>
            <h1 className="mt-3 text-5xl font-bold tracking-tight text-white md:text-6xl">Let’s talk.</h1>
            <p className="mt-5 max-w-md text-lg text-slate-400">
              Questions about a feature, an enterprise plan, or partnership? Drop us a line and an operator
              will reply within one business day.
            </p>
            <div className="mt-10 space-y-5">
              <div className="flex items-start gap-3">
                <Mail className="mt-1 h-5 w-5 text-amber-400" />
                <div>
                  <div className="text-sm font-semibold text-white">Email</div>
                  <div className="text-sm text-slate-400">hello@tbctools.org</div>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <Phone className="mt-1 h-5 w-5 text-amber-400" />
                <div>
                  <div className="text-sm font-semibold text-white">Operations</div>
                  <div className="text-sm text-slate-400">+1 (415) 555-0142</div>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <MapPin className="mt-1 h-5 w-5 text-amber-400" />
                <div>
                  <div className="text-sm font-semibold text-white">HQ</div>
                  <div className="text-sm text-slate-400">340 Bryant Street, San Francisco, CA</div>
                </div>
              </div>
            </div>
          </div>

          <form onSubmit={submit} className="rounded-2xl border border-slate-800 bg-slate-900/60 p-7">
            <div className="grid gap-4">
              <div>
                <label className="text-xs font-semibold uppercase tracking-wider text-slate-400">Name</label>
                <Input className="mt-1.5 border-slate-700 bg-slate-950 text-slate-100" value={form.name} onChange={(e)=>setForm({...form,name:e.target.value})} placeholder="Your name" />
              </div>
              <div>
                <label className="text-xs font-semibold uppercase tracking-wider text-slate-400">Email</label>
                <Input className="mt-1.5 border-slate-700 bg-slate-950 text-slate-100" value={form.email} onChange={(e)=>setForm({...form,email:e.target.value})} placeholder="you@email.com" />
              </div>
              <div>
                <label className="text-xs font-semibold uppercase tracking-wider text-slate-400">Subject</label>
                <Input className="mt-1.5 border-slate-700 bg-slate-950 text-slate-100" value={form.subject} onChange={(e)=>setForm({...form,subject:e.target.value})} placeholder="What's this about?" />
              </div>
              <div>
                <label className="text-xs font-semibold uppercase tracking-wider text-slate-400">Message</label>
                <Textarea rows={5} className="mt-1.5 border-slate-700 bg-slate-950 text-slate-100" value={form.message} onChange={(e)=>setForm({...form,message:e.target.value})} placeholder="Tell us a bit more..." />
              </div>
              <Button type="submit" disabled={submitting} className="bg-amber-500 text-slate-950 hover:bg-amber-400 font-semibold">
                {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />} Send message
              </Button>
            </div>
          </form>
        </div>
      </section>
      <Footer />
    </div>
  );
}
