import React, { useState } from 'react';
import './QuestionDialog.css';

interface QuestionOption {
  label: string;
  description?: string;
}

interface QuestionRequest {
  id: string;
  sessionId: string;
  header: string;
  question: string;
  options: QuestionOption[];
  multiple?: boolean;
}

interface QuestionDialogProps {
  request: QuestionRequest;
  onAnswer: (answers: string[]) => void;
}

export const QuestionDialog: React.FC<QuestionDialogProps> = ({ request, onAnswer }) => {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const toggleOption = (label: string) => {
    if (request.multiple) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(label)) {
          next.delete(label);
        } else {
          next.add(label);
        }
        return next;
      });
    } else {
      setSelected(new Set([label]));
    }
  };

  const handleSubmit = () => {
    onAnswer(Array.from(selected));
  };

  return (
    <div className="question-overlay" role="dialog" aria-modal="true">
      <div className="question-dialog">
        <div className="question-header">
          <h3>{request.header}</h3>
        </div>

        <div className="question-body">
          <p className="question-text">{request.question}</p>

          <div className="question-options">
            {request.options.map((option) => (
              <label
                key={option.label}
                className={`question-option ${selected.has(option.label) ? 'selected' : ''}`}
              >
                <input
                  type={request.multiple ? 'checkbox' : 'radio'}
                  checked={selected.has(option.label)}
                  onChange={() => toggleOption(option.label)}
                />
                <div className="option-content">
                  <span className="option-label">{option.label}</span>
                  {option.description && (
                    <span className="option-description">{option.description}</span>
                  )}
                </div>
              </label>
            ))}
          </div>
        </div>

        <div className="question-footer">
          <button className="btn btn-submit" onClick={handleSubmit} disabled={selected.size === 0}>
            Submit
          </button>
        </div>
      </div>
    </div>
  );
};
