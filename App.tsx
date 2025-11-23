import React, { useState, useRef, useEffect } from 'react';
import { TopBar } from './components/TopBar';
import { CustomKeyboard } from './components/CustomKeyboard';
import { Language, SpeechRecognition, SpeechRecognitionEvent, SpeechRecognitionErrorEvent } from './types';
import { speakText } from './services/geminiService';
import { processTextChunk } from './services/textProcessing';

const App: React.FC = () => {
  const [text, setText] = useState<string>("");
  const [language, setLanguage] = useState<Language>(Language.ES);
  const [isListening, setIsListening] = useState(false);
  const [audioState, setAudioState] = useState<'idle' | 'loading' | 'playing'>('idle');
  const [showSystemKeyboard, setShowSystemKeyboard] = useState(false);
  
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  // Track user intent separately from engine state to handle auto-restart
  const shouldListenRef = useRef(false); 
  const stopAudioRef = useRef<(() => void) | undefined>(undefined);

  // --- Speech Recognition Setup ---
  useEffect(() => {
    if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      const recognition = new SpeechRecognition();
      // continuous must be true for long sessions
      recognition.continuous = true;
      // interimResults false fixes the "repetition/echo" bug on Android/Chrome
      // by only accepting finalized chunks of text.
      recognition.interimResults = false; 
      recognition.lang = language;

      recognition.onresult = (event: SpeechRecognitionEvent) => {
        let finalTranscriptChunk = '';

        // We only iterate from resultIndex to avoid reprocessing old history
        for (let i = event.resultIndex; i < event.results.length; ++i) {
          if (event.results[i].isFinal) {
            finalTranscriptChunk += event.results[i][0].transcript;
          }
        }

        if (finalTranscriptChunk) {
           // Get current text to determine context (capitalization, etc.)
           const currentText = textareaRef.current?.value || "";
           
           // Process the chunk (Fix case, spacing, punctuation)
           const processedChunk = processTextChunk(finalTranscriptChunk, currentText, language);
           
           // Determine if we need a leading space for separation
           // If the previous char is not a whitespace and not a newline, add a space
           let separator = '';
           if (currentText.length > 0 && !/\s$/.test(currentText)) {
             // Check if the processed chunk starts with punctuation that doesn't need space (e.g. dot)
             if (!/^[.,;:!?]/.test(processedChunk.trim())) {
                separator = ' ';
             }
           }

           insertTextAtCursor(separator + processedChunk.trim());
        }
      };

      recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
        console.error("Speech recognition error", event.error);
        // 'no-speech' is common, we ignore it and let onend handle the restart
        if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
           setIsListening(false);
           shouldListenRef.current = false;
        }
      };

      recognition.onend = () => {
        // If user still wants to listen, restart immediately
        if (shouldListenRef.current) {
           try {
             recognition.start();
           } catch (e) {
             console.error("Failed to restart recognition", e);
             setIsListening(false);
             shouldListenRef.current = false;
           }
        } else {
           setIsListening(false);
        }
      };

      recognitionRef.current = recognition;

      // Cleanup: If language changes or component unmounts, kill the old instance
      return () => {
        recognition.abort();
      };
    } else {
      alert("Tu navegador no soporta Web Speech API. Usa Chrome o Edge.");
    }
  }, [language]);

  const toggleListening = () => {
    if (!recognitionRef.current) return;

    if (shouldListenRef.current) {
      // User wants to STOP
      shouldListenRef.current = false;
      recognitionRef.current.stop();
      setIsListening(false);
    } else {
      // User wants to START
      try {
        // Stop playback if active
        if (audioState !== 'idle') handleStopAudio();
        
        shouldListenRef.current = true;
        recognitionRef.current.start();
        setIsListening(true);
        
        // Focus text area so keyboard/cursor logic works
        textareaRef.current?.focus();
      } catch (e) {
        console.error(e);
        setIsListening(false);
        shouldListenRef.current = false;
      }
    }
  };

  // --- Text Manipulation Helper ---
  const insertTextAtCursor = (textToInsert: string) => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const currentText = textarea.value;

    const newText = currentText.substring(0, start) + textToInsert + currentText.substring(end);
    
    setText(newText);
    
    requestAnimationFrame(() => {
      const newCursorPos = start + textToInsert.length;
      textarea.selectionStart = textarea.selectionEnd = newCursorPos;
      
      // Auto-scroll logic
      if (textarea.scrollHeight > textarea.clientHeight) {
        // If we are appending near the end, scroll to bottom
        if (newCursorPos >= newText.length - 5) {
           textarea.scrollTop = textarea.scrollHeight;
        } else {
           // Otherwise try to keep cursor in view (basic approach)
           textarea.blur();
           textarea.focus();
        }
      } else {
        textarea.focus();
      }
    });
  };

  const deleteAtCursor = (mode: 'CHAR' | 'WORD') => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const currentText = textarea.value;

    if (start !== end) {
      const newText = currentText.substring(0, start) + currentText.substring(end);
      setText(newText);
      requestAnimationFrame(() => {
        textarea.selectionStart = textarea.selectionEnd = start;
        textarea.focus();
      });
      return;
    }

    if (start === 0) return;

    let deleteCount = 1;
    if (mode === 'WORD') {
       const textBefore = currentText.substring(0, start);
       const trimmedBefore = textBefore.trimEnd();
       
       const lastSpaceIndex = trimmedBefore.lastIndexOf(' ');
       const targetIndex = lastSpaceIndex === -1 ? 0 : lastSpaceIndex + 1;
       deleteCount = start - targetIndex;
       if (deleteCount === 0 && start > 0) deleteCount = 1;
    }

    const newText = currentText.substring(0, start - deleteCount) + currentText.substring(end);
    setText(newText);
    
    requestAnimationFrame(() => {
        textarea.selectionStart = textarea.selectionEnd = start - deleteCount;
        textarea.focus();
    });
  };

  const toggleCase = () => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    let start = textarea.selectionStart;
    let end = textarea.selectionEnd;
    const textStr = textarea.value;

    let targetStart = start;
    let targetEnd = end;
    let selectedText = "";

    if (start === end) {
      while (targetStart > 0 && !/[\s\p{P}]/u.test(textStr[targetStart - 1])) {
        targetStart--;
      }
      while (targetEnd < textStr.length && !/[\s\p{P}]/u.test(textStr[targetEnd])) {
        targetEnd++;
      }
    }

    if (targetStart === targetEnd) return;

    selectedText = textStr.substring(targetStart, targetEnd);
    if (!selectedText) return;

    const isUpper = selectedText === selectedText.toUpperCase();
    const isLower = selectedText === selectedText.toLowerCase();
    const firstChar = selectedText.charAt(0);
    const rest = selectedText.slice(1);
    const isTitle = firstChar === firstChar.toUpperCase() && rest === rest.toLowerCase() && !isUpper;

    let newTextChunk = "";
    
    if (isLower) {
      newTextChunk = firstChar.toUpperCase() + rest.toLowerCase();
    } else if (isTitle) {
      newTextChunk = selectedText.toUpperCase();
    } else {
      newTextChunk = selectedText.toLowerCase();
    }

    const newFullText = textStr.substring(0, targetStart) + newTextChunk + textStr.substring(targetEnd);
    setText(newFullText);

    requestAnimationFrame(() => {
      textarea.selectionStart = targetStart;
      textarea.selectionEnd = targetStart + newTextChunk.length;
      textarea.focus();
    });
  };

  // --- Custom Keyboard Handler ---
  const handleKeyboardPress = (key: string, type: 'CHAR' | 'BACKSPACE' | 'ENTER' | 'SPACE' | 'DELETE_WORD' | 'TOGGLE_CASE') => {
    // Stop audio if user types
    if (audioState !== 'idle') handleStopAudio();

    if (type === 'BACKSPACE') {
      deleteAtCursor('CHAR');
    } else if (type === 'DELETE_WORD') {
      deleteAtCursor('WORD');
    } else if (type === 'TOGGLE_CASE') {
      toggleCase();
    } else {
      insertTextAtCursor(key);
    }
    
    if (!showSystemKeyboard) {
        textareaRef.current?.focus();
    }
  };

  // --- Toolbar Handlers ---
  const handleCopy = () => {
    navigator.clipboard.writeText(text).then(() => {
      if (navigator.vibrate) navigator.vibrate(50);
    });
  };

  const handleClear = () => {
    // Immediately clear without confirmation
    setText("");
    if (textareaRef.current) {
      textareaRef.current.focus();
    }
    if (audioState !== 'idle') handleStopAudio();
  };

  const handlePlay = async () => {
    if (!text.trim()) return;
    if (shouldListenRef.current) toggleListening(); // Stop listening if playing
    
    setAudioState('loading');
    
    // Store the original text length to map progress
    const textLength = text.length;

    const stopFn = await speakText(
      text, 
      language, 
      (percentage) => {
        // Progress callback (0 to 1)
        if (textareaRef.current) {
          setAudioState('playing');
          // Linear interpolation for cursor
          const cursorPosition = Math.min(Math.floor(textLength * percentage), textLength);
          
          // Keep selection collapsed at current reading point
          textareaRef.current.setSelectionRange(cursorPosition, cursorPosition);
          
          // Ensure focus is kept to show cursor and scroll if needed
          if (document.activeElement !== textareaRef.current) {
             textareaRef.current.focus();
          }
           // Simple scroll to cursor during playback
           const textarea = textareaRef.current;
           if(textarea.scrollHeight > textarea.clientHeight) {
              // Calculate rough scroll position
              const scrollRatio = cursorPosition / textLength;
              textarea.scrollTop = (textarea.scrollHeight - textarea.clientHeight) * scrollRatio;
           }
        }
      },
      () => {
        setAudioState('idle');
        stopAudioRef.current = undefined;
      }
    );
    
    stopAudioRef.current = stopFn;
  };

  const handleStopAudio = () => {
    if (stopAudioRef.current) {
      stopAudioRef.current();
      stopAudioRef.current = undefined;
    }
    setAudioState('idle');
  };

  return (
    <div className="flex flex-col h-full w-full bg-slate-900 text-slate-100">
      <TopBar
        language={language}
        setLanguage={setLanguage}
        onCopy={handleCopy}
        onClear={handleClear}
        isListening={isListening}
        toggleListening={toggleListening}
        onPlay={handlePlay}
        onStop={handleStopAudio}
        audioState={audioState}
        showSystemKeyboard={showSystemKeyboard}
        toggleSystemKeyboard={() => setShowSystemKeyboard(!showSystemKeyboard)}
      />

      <main className="flex-1 relative w-full flex flex-col min-h-0">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => {
             setText(e.target.value);
             // If user types, stop audio
             if (audioState !== 'idle') handleStopAudio();
          }}
          className="flex-1 w-full p-4 sm:p-6 text-lg sm:text-xl leading-relaxed resize-none outline-none bg-transparent text-slate-200 font-mono placeholder-slate-600 overflow-y-auto"
          placeholder="Toque el micrófono para dictar o use el teclado..."
          spellCheck={showSystemKeyboard}
          inputMode={showSystemKeyboard ? 'text' : 'none'}
        />
      </main>

      {/* Custom Keyboard area */}
      <CustomKeyboard onKeyPress={handleKeyboardPress} />
    </div>
  );
};

export default App;