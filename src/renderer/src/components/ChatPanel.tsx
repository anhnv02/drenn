import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Markdown } from '../shared/Markdown';
import { useConfirm } from '../shared/confirm';
import { ChatUserBubble } from './ChatUserBubble';
import { ChatToolCall, type ToolCallDisplay } from './ChatToolCall';
import { Codicon } from './Codicon';
import { PermissionDialog, type PermissionDialogResponse } from './PermissionDialog';
import { QuestionDialog } from './QuestionDialog';
import { RubikLoader } from './RubikLoader';
import type {
  AgentMode,
  CustomCommand,
  ModelChoice,
  Session,
  SkillInfo,
  TranscriptStep,
} from '../../../shared/types';
import type { PermissionRequestPayload } from '../../../shared/ipc';
import './ChatPanel.css';

function ChevronDown() {
  return (
    <svg
      className="chat-select-arrow"
      width="9"
      height="6"
      viewBox="0 0 10 6"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M1 1L5 5L9 1"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25v-7.5z" />
      <path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25v-7.5zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25h-7.5z" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0z" />
    </svg>
  );
}

const MODES: AgentMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];

function groupModelsByProvider(
  models: ModelChoice[],
): { providerId: string; providerName: string; items: { model: ModelChoice; index: number }[] }[] {
  const groups: {
    providerId: string;
    providerName: string;
    items: { model: ModelChoice; index: number }[];
  }[] = [];
  const byProviderId = new Map<string, (typeof groups)[number]>();
  models.forEach((model, index) => {
    let group = byProviderId.get(model.providerId);
    if (!group) {
      group = { providerId: model.providerId, providerName: model.providerName, items: [] };
      byProviderId.set(model.providerId, group);
      groups.push(group);
    }
    group.items.push({ model, index });
  });
  return groups;
}

function commandSuffix(id: string): string {
  const i = id.indexOf(':');
  return i === -1 ? id : id.slice(i + 1);
}

function matchCustomCommand(
  text: string,
  commands: CustomCommand[],
): { command: CustomCommand; args: Record<string, string> } | null {
  if (!text.startsWith('/')) return null;
  const [token, ...rest] = text.slice(1).split(/\s+/);
  const command = commands.find((c) => commandSuffix(c.id).toLowerCase() === token.toLowerCase());
  if (!command) return null;

  const args: Record<string, string> = {};
  for (const part of rest) {
    const eq = part.indexOf('=');
    if (eq > 0) args[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1);
  }
  return { command, args };
}

function matchSkill(text: string, skills: SkillInfo[]): { skill: SkillInfo; args: string } | null {
  if (!text.startsWith('/')) return null;
  const [token, ...rest] = text.slice(1).split(/\s+/);
  const skill = skills.find((s) => s.name.toLowerCase() === token.toLowerCase());
  if (!skill) return null;
  return { skill, args: rest.join(' ') };
}

interface SlashCommand {
  name: string;
  description: string;
  builtin: true;
}

const BUILTIN_SLASH_COMMANDS: SlashCommand[] = [
  { name: 'clear', description: 'Clear conversation history', builtin: true },
];

type SlashMenuItem =
  | SlashCommand
  | { name: string; description: string; builtin: false; command: CustomCommand }
  | { name: string; description: string; builtin: false; skill: SkillInfo };

function slashFilterQuery(input: string): string | null {
  const match = input.match(/^\/(\S*)$/);
  return match ? match[1].toLowerCase() : null;
}

function buildSlashMenuItems(
  filter: string,
  commands: CustomCommand[],
  skills: SkillInfo[],
): SlashMenuItem[] {
  const builtins = BUILTIN_SLASH_COMMANDS.filter((c) => c.name.toLowerCase().includes(filter));
  const customs: SlashMenuItem[] = commands
    .filter((c) => commandSuffix(c.id).toLowerCase().includes(filter))
    .map((c) => ({
      name: commandSuffix(c.id),
      description: c.description || c.title,
      builtin: false as const,
      command: c,
    }));
  const skillItems: SlashMenuItem[] = skills
    .filter((s) => s.name.toLowerCase().includes(filter))
    .map((s) => ({
      name: s.name,
      description: s.description,
      builtin: false as const,
      skill: s,
    }));
  return [...builtins, ...customs, ...skillItems];
}

const MODE_LABELS: Record<AgentMode, string> = {
  default: 'Default',
  acceptEdits: 'Accept Edits',
  plan: 'Plan',
  bypassPermissions: 'Bypass Permissions',
};

const MODE_HINTS: Record<AgentMode, string> = {
  default: 'Ask permission for every sensitive action',
  acceptEdits: 'Auto-approve file edits; still ask for commands',
  plan: 'Read-only: file edits blocked, bash limited to read-only commands',
  bypassPermissions: 'Auto-approve everything: edits, commands, fetch and MCP run without asking',
};

interface FileAttachment {
  name: string;
  content: string;
  type: 'image' | 'text';
}

const MAX_FILE_CONTENT_CHARS = 120_000;

export function ChatPanel({
  session,
  runningSessions,
  onRunningSessionsChange,
  onToolResult,
}: {
  session: Session | undefined;
  runningSessions: Set<string>;
  onRunningSessionsChange: React.Dispatch<React.SetStateAction<Set<string>>>;
  onToolResult?: (sessionId: string) => void;
}) {
  const [steps, setSteps] = useState<TranscriptStep[]>([]);
  const [input, setInput] = useState('');
  const isComposingRef = useRef(false);
  const [toolCallsBySession, setToolCallsBySession] = useState<Map<string, ToolCallDisplay[]>>(
    new Map(),
  );
  const [currentContentBySession, setCurrentContentBySession] = useState<Map<string, string>>(
    new Map(),
  );
  const currentContentRefs = useRef<Map<string, string>>(new Map());
  const [thinkingBySession, setThinkingBySession] = useState<Map<string, string>>(new Map());
  const thinkingRefs = useRef<Map<string, string>>(new Map());
  const [fileAttachments, setFileAttachments] = useState<FileAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const setRunningSessions = onRunningSessionsChange;
  const [pendingPermissionBySession, setPendingPermissionBySession] = useState<
    Map<string, PermissionRequestPayload[]>
  >(new Map());
  const [pendingQuestionBySession, setPendingQuestionBySession] = useState<Map<string, any>>(
    new Map(),
  );
  const sessionIdRef = useRef<string | undefined>(session?.id);
  const toolCalls = session ? (toolCallsBySession.get(session.id) ?? []) : [];
  const currentContent = session ? (currentContentBySession.get(session.id) ?? '') : '';
  const currentThinking = session ? (thinkingBySession.get(session.id) ?? '') : '';
  const isRunning = session ? runningSessions.has(session.id) : false;
  const pendingPermission = session
    ? (pendingPermissionBySession.get(session.id)?.[0] ?? null)
    : null;
  const pendingQuestion = session ? (pendingQuestionBySession.get(session.id) ?? null) : null;
  const [models, setModels] = useState<ModelChoice[]>([]);
  const [selectedModelIndex, setSelectedModelIndex] = useState(0);
  const [mode, setMode] = useState<AgentMode>('default');
  const [commands, setCommands] = useState<CustomCommand[]>([]);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const { confirm } = useConfirm();
  const [editorAvailable, setEditorAvailable] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [selectedSlashIndex, setSelectedSlashIndex] = useState(0);
  const slashMenuRef = useRef<HTMLDivElement>(null);
  const [copiedStepId, setCopiedStepId] = useState<string | null>(null);
  const [tokenUsage, setTokenUsage] = useState<{ input: number; output: number } | null>(null);

  useEffect(() => {
    api.getAvailableEditor().then(({ editor }) => setEditorAvailable(!!editor));
  }, []);

  useEffect(() => {
    api.getModels().then(({ models, selected }) => {
      setModels(models);
      setSelectedModelIndex(
        selected
          ? models.findIndex(
              (m) => m.providerId === selected.providerId && m.modelId === selected.modelId,
            )
          : 0,
      );
    });

    function onSettingsSaved() {
      api.getModels().then(({ models, selected }) => {
        setModels(models);
        setSelectedModelIndex(
          selected
            ? models.findIndex(
                (m) => m.providerId === selected.providerId && m.modelId === selected.modelId,
              )
            : 0,
        );
      });
    }
    window.addEventListener('settings:saved', onSettingsSaved);
    return () => window.removeEventListener('settings:saved', onSettingsSaved);
  }, []);

  useEffect(() => {
    if (!session) return;
    api.getAgentMode(session.id).then(setMode);
  }, [session?.id]);

  useEffect(() => {
    setTokenUsage(null);
    if (!session) {
      setCommands([]);
      setSkills([]);
      return;
    }
    api.getCommands(session.id).then(({ commands }) => setCommands(commands));
    api.getSkills(session.id).then(({ skills }) => setSkills(skills));
  }, [session?.id]);

  useEffect(() => {
    sessionIdRef.current = session?.id;
  }, [session?.id]);

  useEffect(() => {
    if (!session) return;
    api.getTranscript(session.id).then((transcript) => setSteps(transcript.steps));
  }, [session?.id]);

  useEffect(() => {
    return api.onAgentEvent((event) => {
      const sid = event.sessionId;
      const isActive = sid === sessionIdRef.current;

      switch (event.type) {
        case 'mode':
          if (isActive && event.mode) setMode(event.mode);
          break;
        case 'thinking':
          if (event.content) {
            const next = (thinkingRefs.current.get(sid) ?? '') + event.content;
            thinkingRefs.current.set(sid, next);
            setThinkingBySession((prev) => new Map(prev).set(sid, next));
          }
          break;
        case 'content':
          if (event.content) {
            const next = (currentContentRefs.current.get(sid) ?? '') + event.content;
            currentContentRefs.current.set(sid, next);
            setCurrentContentBySession((prev) => new Map(prev).set(sid, next));
          }
          break;
        case 'tool_use': {
          const toolCall = event.toolCall;
          if (toolCall) {
            setToolCallsBySession((prev) => {
              const existing = prev.get(sid) ?? [];
              const found = existing.find((tc) => tc.id === toolCall.id);
              const updated = found
                ? existing.map((tc) =>
                    tc.id === toolCall.id ? { ...tc, input: toolCall.input } : tc,
                  )
                : [...existing, { id: toolCall.id, name: toolCall.name, input: toolCall.input }];
              return new Map(prev).set(sid, updated);
            });
          }
          break;
        }
        case 'tool_result':
          if (event.toolCall && event.toolResult) {
            const finalized: ToolCallDisplay = {
              id: event.toolCall.id,
              name: event.toolCall.name,
              input: event.toolCall.input,
              result: event.toolResult,
            };
            if (isActive) {
              setSteps((prev) => [
                ...prev,
                {
                  id: `toolcall-${finalized.id}`,
                  heading: 'ToolCall',
                  finished: true,
                  blocks: [{ kind: 'tool', content: JSON.stringify(finalized) }],
                },
              ]);
            }
            setToolCallsBySession((prev) => {
              const existing = prev.get(sid) ?? [];
              return new Map(prev).set(
                sid,
                existing.filter((tc) => tc.id !== finalized.id),
              );
            });
            if (isActive) onToolResult?.(sid);
          }
          break;
        case 'complete': {
          const content = currentContentRefs.current.get(sid);
          if (content) {
            if (isActive) {
              setSteps((prev) => [
                ...prev,
                {
                  id: `agent-${Date.now()}`,
                  heading: 'Assistant',
                  finished: true,
                  blocks: [{ kind: 'text', content }],
                },
              ]);
            }
            currentContentRefs.current.set(sid, '');
            setCurrentContentBySession((prev) => new Map(prev).set(sid, ''));
          }
          thinkingRefs.current.set(sid, '');
          setThinkingBySession((prev) => new Map(prev).set(sid, ''));
          if (isActive && event.usage) {
            setTokenUsage({ input: event.usage.inputTokens, output: event.usage.outputTokens });
          }
          break;
        }
        case 'done':
          setRunningSessions((prev) => {
            const next = new Set(prev);
            next.delete(sid);
            return next;
          });
          break;
        case 'system':
          if (event.content && isActive) {
            setSteps((prev) => [
              ...prev,
              {
                id: `system-${Date.now()}`,
                heading: 'System',
                finished: true,
                blocks: [{ kind: 'text', content: event.content! }],
              },
            ]);
          }
          break;
        case 'error':
          if (isActive) {
            setSteps((prev) => [
              ...prev,
              {
                id: `agent-error-${Date.now()}`,
                heading: 'Error',
                finished: true,
                blocks: [{ kind: 'text', content: event.error || 'Something went wrong.' }],
              },
            ]);
          }
          currentContentRefs.current.set(sid, '');
          setCurrentContentBySession((prev) => new Map(prev).set(sid, ''));
          thinkingRefs.current.set(sid, '');
          setThinkingBySession((prev) => new Map(prev).set(sid, ''));
          setToolCallsBySession((prev) => new Map(prev).set(sid, []));
          setRunningSessions((prev) => {
            const next = new Set(prev);
            next.delete(sid);
            return next;
          });
          break;
      }
    });
  }, []);

  useEffect(() => {
    return api.onPermissionRequest((request) => {
      setPendingPermissionBySession((prev) => {
        const queue = prev.get(request.sessionId) ?? [];
        return new Map(prev).set(request.sessionId, [...queue, request]);
      });
    });
  }, []);

  useEffect(() => {
    return api.onPermissionClearSession(({ sessionId }) => {
      setPendingPermissionBySession((prev) => {
        if (!prev.has(sessionId)) return prev;
        const next = new Map(prev);
        next.delete(sessionId);
        return next;
      });
    });
  }, []);

  useEffect(() => {
    return api.onQuestionRequest((request) => {
      setPendingQuestionBySession((prev) => new Map(prev).set(request.sessionId, request));
    });
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [steps, currentContent, toolCalls, isRunning]);

  useEffect(() => {
    if (!slashMenuOpen) return;
    function handleClick(e: MouseEvent) {
      if (slashMenuRef.current && !slashMenuRef.current.contains(e.target as Node)) {
        setSlashMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick, true);
    return () => document.removeEventListener('mousedown', handleClick, true);
  }, [slashMenuOpen]);

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = Array.from(e.clipboardData?.items ?? []);
    const pastedFiles = items
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((f): f is File => f !== null);
    if (pastedFiles.length > 0) {
      e.preventDefault();
      readFiles(pastedFiles);
    }
  }

  function readFiles(files: File[]) {
    for (const file of files) {
      if (file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = () => {
          if (typeof reader.result === 'string') {
            setFileAttachments((prev) => [
              ...prev,
              { name: file.name, content: reader.result as string, type: 'image' },
            ]);
          }
        };
        reader.readAsDataURL(file);
      } else {
        const reader = new FileReader();
        reader.onload = () => {
          if (typeof reader.result === 'string') {
            setFileAttachments((prev) => [
              ...prev,
              { name: file.name, content: reader.result as string, type: 'text' },
            ]);
          }
        };
        reader.readAsText(file);
      }
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) readFiles(files);
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (e.currentTarget === e.target) setIsDragOver(false);
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) readFiles(files);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  async function executeSlashCommand(item: SlashMenuItem) {
    setInput('');
    setSlashMenuOpen(false);
    if (item.name === 'clear') {
      if (!session) return;
      if (isRunning) {
        await api.cancelAgent(session.id);
        setRunningSessions((prev) => {
          const next = new Set(prev);
          next.delete(session.id);
          return next;
        });
      }
      await api.clearTranscript(session.id);
      setSteps([]);
      currentContentRefs.current.set(session.id, '');
      setCurrentContentBySession((prev) => new Map(prev).set(session.id, ''));
      thinkingRefs.current.set(session.id, '');
      setThinkingBySession((prev) => new Map(prev).set(session.id, ''));
      setToolCallsBySession((prev) => new Map(prev).set(session.id, []));
      return;
    }
    if (!item.builtin && ('command' in item || 'skill' in item)) {
      setInput(`/${item.name} `);
    }
  }

  function send(delivery: 'steer' | 'queue' = 'queue') {
    const text = input.trim();
    if (!text || !session) return;
    setSlashMenuOpen(false);

    let prompt = text;
    const fileContextParts: string[] = [];
    for (const fa of fileAttachments) {
      if (fa.type === 'text') {
        const truncated =
          fa.content.length > MAX_FILE_CONTENT_CHARS
            ? fa.content.slice(0, MAX_FILE_CONTENT_CHARS) + '\n... (truncated)'
            : fa.content;
        fileContextParts.push(`<file path="${fa.name}">\n${truncated}\n</file>`);
      }
    }
    if (fileContextParts.length > 0) {
      prompt = fileContextParts.join('\n\n') + '\n\n' + text;
    }

    const images = fileAttachments.filter((fa) => fa.type === 'image').map((fa) => fa.content);

    if (images.length > 0 && selectedModel?.vision === false) {
      setFileAttachments([]);
      setInput('');
      setSteps((prev) => [
        ...prev,
        {
          id: `local-${Date.now()}`,
          heading: 'You',
          finished: true,
          blocks: [
            { kind: 'text', content: prompt },
            ...images.map((url) => ({ kind: 'image' as const, content: url })),
            ...fileAttachments
              .filter((fa) => fa.type === 'text')
              .map((fa) => ({ kind: 'file' as const, content: fa.name })),
          ],
        },
        {
          id: `error-${Date.now()}`,
          heading: 'Error',
          finished: true,
          blocks: [
            {
              kind: 'text',
              content: `The selected model "${selectedModel?.modelName}" does not support image input. Please select a vision-capable model or remove the attached images.`,
            },
          ],
        },
      ]);
      return;
    }

    if (isRunning) {
      api.enqueueInput(session.id, prompt, delivery);
      setSteps((prev) => [
        ...prev,
        {
          id: `local-${Date.now()}`,
          heading: 'You',
          finished: true,
          blocks: [
            { kind: 'text', content: prompt },
            ...fileAttachments.map((fa) => ({ kind: 'file' as const, content: fa.name })),
          ],
        },
      ]);
      setInput('');
      setFileAttachments([]);
      return;
    }

    currentContentRefs.current.set(session.id, '');
    setTokenUsage(null);
    setToolCallsBySession((prev) => new Map(prev).set(session.id, []));
    setCurrentContentBySession((prev) => new Map(prev).set(session.id, ''));
    setRunningSessions((prev) => new Set(prev).add(session.id));

    setSteps((prev) => [
      ...prev,
      {
        id: `local-${Date.now()}`,
        heading: 'You',
        finished: true,
        blocks: [
          { kind: 'text', content: prompt },
          ...images.map((url) => ({ kind: 'image' as const, content: url })),
          ...fileAttachments
            .filter((fa) => fa.type === 'text')
            .map((fa) => ({ kind: 'file' as const, content: fa.name })),
        ],
      },
    ]);

    const matched = matchCustomCommand(text, commands);
    const matchedSkill = matchSkill(text, skills);
    if (matched) {
      api.runCommand(session.id, matched.command.id, matched.args);
    } else if (matchedSkill) {
      api.runSkill(session.id, matchedSkill.skill.name, matchedSkill.args);
    } else {
      api.runAgent(session.id, prompt, images.length ? images : undefined);
    }
    setInput('');
    setFileAttachments([]);
  }

  function cancelAgent() {
    if (session) {
      api.cancelAgent(session.id);
      setRunningSessions((prev) => {
        const next = new Set(prev);
        next.delete(session.id);
        return next;
      });
      currentContentRefs.current.set(session.id, '');
      setCurrentContentBySession((prev) => new Map(prev).set(session.id, ''));
      setToolCallsBySession((prev) => new Map(prev).set(session.id, []));
      setSteps((prev) => [
        ...prev,
        {
          id: `stopped-${Date.now()}`,
          heading: 'Stopped',
          finished: true,
          blocks: [{ kind: 'text', content: 'Cancelled by user.' }],
        },
      ]);
    }
  }

  async function openInEditor() {
    const result = await api.openEditor(input);
    if (!result.cancelled) setInput(result.content);
  }

  function handlePermissionResponse(response: PermissionDialogResponse) {
    if (pendingPermission && session) {
      api.respondPermission({ requestId: pendingPermission.id, ...response });
      setPendingPermissionBySession((prev) => {
        const next = new Map(prev);
        const rest = (next.get(session.id) ?? []).filter((r) => r.id !== pendingPermission.id);
        if (rest.length > 0) next.set(session.id, rest);
        else next.delete(session.id);
        return next;
      });
    }
  }

  function handleQuestionResponse(answers: string[]) {
    if (pendingQuestion && session) {
      api.respondQuestion(pendingQuestion.id, answers);
      setPendingQuestionBySession((prev) => {
        const next = new Map(prev);
        next.delete(session.id);
        return next;
      });
    }
  }

  function handleModelChange(value: string) {
    const index = Number(value);
    setSelectedModelIndex(index);
    const choice = models[index];
    api.selectModel(choice ? { providerId: choice.providerId, modelId: choice.modelId } : null);
  }

  async function handleModeChange(value: AgentMode) {
    if (!session) return;
    if (
      value === 'bypassPermissions' &&
      !(await confirm({
        title: 'Enable Bypass Permissions?',
        message:
          'Bypass Permissions auto-approves every tool action — file edits, shell commands, ' +
          'and network fetches — without asking. Only hard safety floors (banned commands, ' +
          'private-network fetch blocks) still apply.\n\nEnable Bypass Permissions for this session?',
        confirmLabel: 'Enable',
        danger: true,
      }))
    ) {
      return;
    }
    setMode(value);
    api.setAgentMode(session.id, value);
  }

  const selectedModel = selectedModelIndex >= 0 ? models[selectedModelIndex] : undefined;
  const modelLabel = selectedModel?.modelName ?? models[0]?.modelName ?? '';

  const slashFilter = slashFilterQuery(input);
  const slashMenuItems =
    slashFilter !== null ? buildSlashMenuItems(slashFilter, commands, skills) : [];

  function copyStepContent(stepId: string) {
    const step = steps.find((s) => s.id === stepId);
    if (!step) return '';
    return step.blocks
      .filter((b) => b.kind !== 'tool')
      .map((b) => b.content)
      .join('\n\n');
  }

  function handleCopyText(id: string, text: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedStepId(id);
      setTimeout(() => setCopiedStepId(null), 1500);
    });
  }

  return (
    <div className="chat-panel">
      {session && (
        <div className="chat-header">
          <div className="chat-header-title">{session.title}</div>
          <div className="chat-header-sub">
            {session.projectName} · <span className="stat-added">+{session.added}</span>{' '}
            <span className="stat-removed">-{session.removed}</span>
          </div>
        </div>
      )}

      <div className="chat-transcript" ref={scrollRef}>
        {steps.map((step, stepIdx) => {
          const isUser = step.heading === 'You';
          const isSystem = step.heading === 'System';
          if (step.heading === 'ToolCall') {
            let tc: ToolCallDisplay | null = null;
            try {
              tc = JSON.parse(step.blocks[0]?.content ?? 'null');
            } catch {
              tc = null;
            }
            return tc ? <ChatToolCall key={step.id} tc={tc} /> : null;
          }
          if (isSystem) {
            return (
              <div key={step.id} className="chat-system-badge">
                {step.blocks[0]?.content}
              </div>
            );
          }
          const isLastAssistant =
            !isUser &&
            steps
              .slice(stepIdx + 1)
              .every((s) => s.heading === 'ToolCall' || s.heading === 'System');
          return (
            <div
              key={step.id}
              className={`chat-step ${isUser ? 'chat-step-user' : 'chat-step-assistant'}`}
            >
              {isUser ? (
                <ChatUserBubble blocks={step.blocks} />
              ) : (
                <div className="chat-step-content">
                  {step.blocks.map((block, i) => {
                    if (block.kind === 'tool') {
                      return (
                        <div key={i} className="chat-tool-line">
                          <span className="chat-tool-bullet">•</span>
                          <span className="chat-tool-text">{block.content}</span>
                        </div>
                      );
                    }
                    if (block.kind === 'code') {
                      return (
                        <pre key={i}>
                          <code>{block.content}</code>
                        </pre>
                      );
                    }
                    if (block.kind === 'image') {
                      return (
                        <img
                          key={i}
                          className="chat-bubble-image"
                          src={block.content}
                          alt="attached"
                        />
                      );
                    }
                    return <Markdown key={i} text={block.content} />;
                  })}
                  {isLastAssistant && !isRunning && (
                    <div className="chat-copy-btn-row">
                      <button
                        className={`chat-copy-btn ${copiedStepId === step.id ? 'chat-copy-btn-copied' : ''}`}
                        title="Copy response"
                        aria-label="Copy response"
                        onClick={() => handleCopyText(step.id, copyStepContent(step.id))}
                      >
                        {copiedStepId === step.id ? <CheckIcon /> : <CopyIcon />}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {currentThinking && (
          <details className="chat-thinking" open={!currentContent}>
            <summary>Thinking…</summary>
            <div className="chat-thinking-body">{currentThinking}</div>
          </details>
        )}

        {currentContent && (
          <div className="chat-step chat-step-assistant">
            <div className="chat-step-content">
              <Markdown text={currentContent} />
              {!isRunning && (
                <div className="chat-copy-btn-row">
                  <button
                    className={`chat-copy-btn ${copiedStepId === 'streaming' ? 'chat-copy-btn-copied' : ''}`}
                    title="Copy response"
                    aria-label="Copy response"
                    onClick={() => handleCopyText('streaming', currentContent)}
                  >
                    {copiedStepId === 'streaming' ? <CheckIcon /> : <CopyIcon />}
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {toolCalls.map((tc) => (
          <ChatToolCall key={tc.id} tc={tc} />
        ))}

        {isRunning && <RubikLoader />}
      </div>

      {tokenUsage && (
        <div className="chat-status">
          <span className="chat-status-item">
            <span className="chat-status-label">In</span>
            <span className="chat-status-value">{tokenUsage.input.toLocaleString()}</span>
          </span>
          <span className="chat-status-sep" />
          <span className="chat-status-item">
            <span className="chat-status-label">Out</span>
            <span className="chat-status-value">{tokenUsage.output.toLocaleString()}</span>
          </span>
        </div>
      )}

      <div
        className={`chat-input-bar${isDragOver ? ' chat-input-bar-dragover' : ''}`}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
      >
        {isDragOver && <div className="chat-drag-overlay">Drop files here</div>}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="chat-file-input-hidden"
          onChange={handleFileSelect}
          tabIndex={-1}
        />
        {pendingPermission && (
          <PermissionDialog request={pendingPermission} onRespond={handlePermissionResponse} />
        )}
        {fileAttachments.length > 0 && (
          <div className="chat-attachments">
            {fileAttachments.map((fa, i) =>
              fa.type === 'image' ? (
                <div key={i} className="chat-attachment">
                  <img src={fa.content} alt={fa.name} />
                  <button
                    className="chat-attachment-remove"
                    title={`Remove ${fa.name}`}
                    onClick={() => setFileAttachments((prev) => prev.filter((_, j) => j !== i))}
                  >
                    ×
                  </button>
                </div>
              ) : (
                <div key={i} className="chat-file-chip">
                  <Codicon name="file" size={12} />
                  <span className="chat-file-chip-name">{fa.name}</span>
                  <button
                    className="chat-attachment-remove"
                    title={`Remove ${fa.name}`}
                    onClick={() => setFileAttachments((prev) => prev.filter((_, j) => j !== i))}
                  >
                    ×
                  </button>
                </div>
              ),
            )}
          </div>
        )}
        {slashMenuOpen && slashMenuItems.length > 0 && (
          <div className="slash-menu" ref={slashMenuRef}>
            {slashMenuItems.map((item, i) => (
              <div
                key={item.name}
                className={`slash-menu-item ${i === selectedSlashIndex ? 'slash-menu-item-active' : ''}`}
                onMouseEnter={() => setSelectedSlashIndex(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  executeSlashCommand(item);
                }}
              >
                <span className="slash-menu-name">/{item.name}</span>
                <span className="slash-menu-desc">{item.description}</span>
              </div>
            ))}
          </div>
        )}
        <textarea
          className="chat-input"
          placeholder={
            isRunning
              ? 'Send follow-up (queued after this run) — ⌘/Ctrl+Enter to steer ahead of the queue'
              : 'Ask me anything about your code...'
          }
          aria-label="Chat input"
          value={input}
          onChange={(e) => {
            const val = e.target.value;
            setInput(val);
            const query = slashFilterQuery(val);
            if (query !== null) {
              setSlashMenuOpen(true);
              setSelectedSlashIndex(0);
            } else {
              setSlashMenuOpen(false);
            }
          }}
          onPaste={handlePaste}
          onFocus={() => {
            const query = slashFilterQuery(input);
            if (query !== null) {
              setSlashMenuOpen(true);
              setSelectedSlashIndex(0);
            }
          }}
          onCompositionStart={() => (isComposingRef.current = true)}
          onCompositionEnd={() => (isComposingRef.current = false)}
          onKeyDown={(e) => {
            if (slashMenuOpen && slashMenuItems.length > 0) {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSelectedSlashIndex((i) => (i + 1) % slashMenuItems.length);
                return;
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSelectedSlashIndex(
                  (i) => (i - 1 + slashMenuItems.length) % slashMenuItems.length,
                );
                return;
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                if (isComposingRef.current || e.nativeEvent.isComposing || e.keyCode === 229) {
                  return;
                }
                e.preventDefault();
                executeSlashCommand(slashMenuItems[selectedSlashIndex]);
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                setSlashMenuOpen(false);
                return;
              }
            }

            if (e.key === 'Enter' && !e.shiftKey) {
              if (isComposingRef.current || e.nativeEvent.isComposing || e.keyCode === 229) {
                return;
              }
              e.preventDefault();
              send(e.metaKey || e.ctrlKey ? 'steer' : 'queue');
            }
          }}
          rows={3}
        />
        <div className="chat-input-footer">
          <div className="chat-input-controls">
            <button
              type="button"
              className="icon-btn chat-attach-btn"
              onClick={() => fileInputRef.current?.click()}
              title="Attach files"
              aria-label="Attach files"
            >
              <Codicon name="add" size={14} />
            </button>
            <div className={`chat-select chat-mode-${mode}`} title={MODE_HINTS[mode]}>
              <span className="chat-select-value">{MODE_LABELS[mode]}</span>
              <ChevronDown />
              <select
                className="chat-select-native"
                value={mode}
                onChange={(e) => handleModeChange(e.target.value as AgentMode)}
                disabled={!session}
              >
                {MODES.map((m) => (
                  <option key={m} value={m}>
                    {MODE_LABELS[m]}
                  </option>
                ))}
              </select>
            </div>
            <div className="chat-select" title="Model used for agent runs">
              <span className="chat-select-value">{modelLabel}</span>
              <ChevronDown />
              <select
                className="chat-select-native"
                value={selectedModelIndex}
                onChange={(e) => handleModelChange(e.target.value)}
              >
                {groupModelsByProvider(models).map((group) => (
                  <optgroup key={group.providerId} label={group.providerName}>
                    {group.items.map(({ model, index }) => (
                      <option key={`${model.providerId}:${model.modelId}`} value={index}>
                        {model.modelName}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>
            {selectedModel && (
              <span className="chat-select-provider">{selectedModel.providerName}</span>
            )}
            {commands.length > 0 && (
              <div className="chat-select" title="Insert a custom command">
                <span className="chat-select-value">Commands</span>
                <ChevronDown />
                <select
                  className="chat-select-native"
                  value=""
                  onChange={(e) => {
                    const command = commands.find((c) => c.id === e.target.value);
                    if (command) setInput(`/${commandSuffix(command.id)} `);
                  }}
                >
                  <option value="" disabled>
                    Select a command…
                  </option>
                  {commands.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {editorAvailable && (
              <button
                type="button"
                className="icon-btn chat-icon-btn"
                onClick={openInEditor}
                disabled={isRunning}
                title="Edit in external editor ($EDITOR)"
                aria-label="Open in external editor"
              >
                <Codicon name="link-external" size={13} />
              </button>
            )}
          </div>
          <div className="chat-send-group">
            {isRunning && (
              <button
                className="icon-btn chat-send-btn chat-send-btn-stop"
                onClick={cancelAgent}
                title="Stop"
                aria-label="Stop"
              >
                <Codicon name="debug-stop" size={15} />
              </button>
            )}
            <button
              className="icon-btn chat-send-btn"
              onClick={(e) => send(e.metaKey || e.ctrlKey ? 'steer' : 'queue')}
              disabled={!input.trim()}
              title="Send"
              aria-label="Send"
            >
              <Codicon name="arrow-up" size={16} />
            </button>
          </div>
        </div>
      </div>

      {pendingQuestion && (
        <QuestionDialog request={pendingQuestion} onAnswer={handleQuestionResponse} />
      )}
    </div>
  );
}
