import { Mic, MicOff, Volume2, VolumeX } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';

interface SpeechRecognitionInstance {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((ev: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((ev: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}

interface VoiceInputButtonProps {
  language: 'auto' | 'en' | 'ne' | 'bilingual';
  onTranscript: (text: string) => void;
  onError: (msg: string) => void;
}

export const VoiceInputButton: React.FC<VoiceInputButtonProps> = ({
  language,
  onTranscript,
  onError,
}) => {
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    return () => {
      recognitionRef.current?.stop();
      if (mediaRecorderRef.current?.state === 'recording') {
        mediaRecorderRef.current.stop();
      }
    };
  }, []);

  const startRecording = async () => {
    const win = window as unknown as {
      SpeechRecognition?: new () => SpeechRecognitionInstance;
      webkitSpeechRecognition?: new () => SpeechRecognitionInstance;
    };
    const SpeechRec = win.SpeechRecognition || win.webkitSpeechRecognition;

    if (SpeechRec) {
      try {
        const rec = new SpeechRec();
        rec.lang = language === 'ne' ? 'ne-NP' : 'en-US';
        rec.interimResults = false;
        rec.continuous = false;
        rec.onresult = (ev) => {
          const transcript = Array.from(ev.results)
            .map((r) => r[0]?.transcript || '')
            .join(' ')
            .trim();
          if (transcript) onTranscript(transcript);
        };
        rec.onerror = (ev) => {
          if (ev.error === 'not-allowed') {
            onError('Microphone permission was denied. Enable microphone access to use voice input.');
          } else {
            onError(`Voice recognition error: ${ev.error}`);
          }
          setRecording(false);
        };
        rec.onend = () => setRecording(false);
        recognitionRef.current = rec;
        rec.start();
        setRecording(true);
        return;
      } catch {
        // Fallback to MediaRecorder + server transcription
      }
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      onError('Voice recording is not supported in this browser.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunksRef.current.push(ev.data);
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        if (blob.size === 0) {
          onError('No audio was captured. Please try speaking again.');
          return;
        }
        setTranscribing(true);
        try {
          const fd = new FormData();
          fd.append('audio', blob, 'voice-question.webm');
          fd.append('language', language);
          const res = await fetch('/api/voice/transcribe', {
            method: 'POST',
            credentials: 'include',
            body: fd,
          });
          const data = (await res.json().catch(() => ({}))) as { error?: string; transcript?: string };
          if (!res.ok) {
            throw new Error(data.error || `Transcription failed (HTTP ${res.status})`);
          }
          if (data.transcript) {
            onTranscript(data.transcript);
          } else {
            onError('No speech could be transcribed from the recording.');
          }
        } catch (err) {
          onError(err instanceof Error ? err.message : 'Audio transcription failed');
        } finally {
          setTranscribing(false);
        }
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setRecording(true);
    } catch {
      onError('Microphone access was denied or unavailable.');
    }
  };

  const stopRecording = () => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
    }
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
    setRecording(false);
  };

  return (
    <button
      type="button"
      onClick={recording ? stopRecording : startRecording}
      disabled={transcribing}
      title={recording ? 'Stop Recording' : 'Voice Input (Requires Microphone Permission)'}
      className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-2 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
        recording
          ? 'border-red-300 bg-red-50 text-red-700 hover:bg-red-100 dark:border-red-800 dark:bg-red-950 dark:text-red-300'
          : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800'
      }`}
    >
      {recording ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
      <span className="hidden sm:inline">
        {transcribing ? 'Transcribing...' : recording ? 'Stop' : 'Voice'}
      </span>
    </button>
  );
};

interface SpeakButtonProps {
  text: string;
}

export const SpeakButton: React.FC<SpeakButtonProps> = ({ text }) => {
  const [speaking, setSpeaking] = useState(false);

  const toggleSpeak = () => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    if (speaking) {
      window.speechSynthesis.cancel();
      setSpeaking(false);
      return;
    }

    window.speechSynthesis.cancel();
    const cleanText = text.replace(/\[Source \d+\]/g, '').replace(/[*#`]/g, '');
    const utterance = new SpeechSynthesisUtterance(cleanText);
    const hasDevanagari = /[\u0900-\u097F]/.test(cleanText);
    const voices = window.speechSynthesis.getVoices();

    if (hasDevanagari) {
      const nepVoice = voices.find((v) => v.lang.toLowerCase().startsWith('ne')) ||
        voices.find((v) => v.lang.toLowerCase().startsWith('hi'));
      if (nepVoice) utterance.voice = nepVoice;
      utterance.lang = nepVoice?.lang || 'ne-NP';
    } else {
      const enVoice = voices.find((v) => v.lang.toLowerCase().startsWith('en'));
      if (enVoice) utterance.voice = enVoice;
      utterance.lang = enVoice?.lang || 'en-US';
    }

    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);
    setSpeaking(true);
    window.speechSynthesis.speak(utterance);
  };

  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    return null;
  }

  return (
    <button
      type="button"
      onClick={toggleSpeak}
      className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
    >
      {speaking ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
      <span>{speaking ? 'Stop' : 'Listen'}</span>
    </button>
  );
};
