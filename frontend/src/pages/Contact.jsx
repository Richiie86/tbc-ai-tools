import React, { useState } from 'react';
import Navbar from '../components/Navbar';
import Footer from '../components/Footer';
import api from '../lib/api';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import { toast } from 'sonner';
import { Send, Loader2, MessageSquareText, Sparkles, CheckCircle2, Clock } from 'lucide-react';

export default function Contact() {
  const [form, setForm] = useState({ name: '', email: '', subject: '', message: '' });
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!form.name || !form.email || !form.message) {
      toast.error('Please fill name, email and message');
      return;
    }
    setSubmitting(true);
    try {
      await api.post('/contact', form);
      setSubmitted(true);
      setForm({ name: '', email: '', subject: '', message: '' });
    } catch (err) {
      toast.error(err?.response?.data?.detail || 'Submission failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-ink-950">
      <Navbar />
      <section className="mx-auto max-w-3xl px-5 py-16 sm:py-24">
        <div className="text-center">
          <div className="text-xs font-semibold uppercase tracking-[0.2em] text-tbc-400">Get in touch</div>
          <h1 className="mt-3 text-4xl font-bold tracking-tight text-white sm:text-5xl">Let&apos;s talk.</h1>
          <p className="mx-auto mt-5 max-w-xl text-base text-slate-400 sm:text-lg">
            Send a message and an operator will reply within one business day.
          </p>
        </div>

        <div className="mx-auto mt-12 grid max-w-2xl gap-4 sm:grid-cols-3" data-testid="contact-promises">
          <Promise icon={Clock} title="< 24h reply" text="On business days" />
          <Promise icon={MessageSquareText} title="Direct to operator" text="No bots — real humans" />
          <Promise icon={Sparkles} title="No spam" text="One thread, no list" />
        </div>

        <div className="mx-auto mt-10 max-w-2xl rounded-2xl border border-slate-800 bg-slate-900/60 p-7" data-testid="contact-form-card">
          {submitted ? (
            <div className="py-12 text-center" data-testid="contact-form-success">
              <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-emerald-500/15 text-emerald-400">
                <CheckCircle2 className="h-7 w-7" />
              </div>
              <h2 className="mt-5 text-xl font-bold text-white">Message sent</h2>
              <p className="mt-2 text-sm text-slate-400">We&apos;ll get back to you at the email you provided.</p>
              <Button
                onClick={() => setSubmitted(false)}
                variant="outline"
                className="mt-6 border-slate-700 bg-ink-950 text-slate-200 hover:bg-slate-800"
                data-testid="contact-send-another"
              >
                Send another message
              </Button>
            </div>
          ) : (
            <form onSubmit={submit} className="grid gap-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="text-xs font-semibold uppercase tracking-wider text-slate-400">Name</label>
                  <Input
                    data-testid="contact-name"
                    className="mt-1.5 border-slate-700 bg-ink-950 text-slate-100"
                    value={form.name}
                    onChange={(e)=>setForm({...form,name:e.target.value})}
                    placeholder="Your name"
                  />
                </div>
                <div>
                  <label className="text-xs font-semibold uppercase tracking-wider text-slate-400">Email</label>
                  <Input
                    data-testid="contact-email"
                    type="email"
                    className="mt-1.5 border-slate-700 bg-ink-950 text-slate-100"
                    value={form.email}
                    onChange={(e)=>setForm({...form,email:e.target.value})}
                    placeholder="you@email.com"
                  />
                </div>
              </div>
              <div>
                <label className="text-xs font-semibold uppercase tracking-wider text-slate-400">Subject</label>
                <Input
                  data-testid="contact-subject"
                  className="mt-1.5 border-slate-700 bg-ink-950 text-slate-100"
                  value={form.subject}
                  onChange={(e)=>setForm({...form,subject:e.target.value})}
                  placeholder="What's this about?"
                />
              </div>
              <div>
                <label className="text-xs font-semibold uppercase tracking-wider text-slate-400">Message</label>
                <Textarea
                  data-testid="contact-message"
                  rows={6}
                  className="mt-1.5 border-slate-700 bg-ink-950 text-slate-100"
                  value={form.message}
                  onChange={(e)=>setForm({...form,message:e.target.value})}
                  placeholder="Tell us a bit more..."
                />
              </div>
              <Button
                type="submit"
                disabled={submitting}
                data-testid="contact-submit"
                className="bg-tbc-500 text-slate-950 hover:bg-tbc-400 font-semibold"
              >
                {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
                Send message
              </Button>
            </form>
          )}
        </div>
      </section>
      <Footer />
    </div>
  );
}

function Promise({ icon: Icon, title, text }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4 text-center">
      <Icon className="mx-auto h-5 w-5 text-tbc-400" />
      <div className="mt-2 text-sm font-semibold text-white">{title}</div>
      <div className="text-xs text-slate-400">{text}</div>
    </div>
  );
}
