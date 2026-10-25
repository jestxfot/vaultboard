// Окно «введи название» вместо window.prompt: в настольном приложении (Electron) prompt не работает вовсе.
import { createSignal, onMount } from 'solid-js';
import { render } from 'solid-js/web';

/** Спросить строку. «Отмена», Esc или щелчок мимо окна — null. */
export function ask(question: string, initial = ''): Promise<string | null> {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    document.body.append(host);
    let dispose = () => {};
    const done = (value: string | null) => {
      dispose();
      host.remove();
      resolve(value);
    };
    dispose = render(() => <AskDialog question={question} initial={initial} onDone={done} />, host);
  });
}

function AskDialog(props: { question: string; initial: string; onDone: (value: string | null) => void }) {
  const [value, setValue] = createSignal(props.initial);
  let input!: HTMLInputElement;
  onMount(() => {
    input.focus();
    input.select();
  });
  return (
    <div class="quick-back" onPointerDown={() => props.onDone(null)}>
      <form
        class="dialog ask"
        onPointerDown={(e) => e.stopPropagation()}
        // Клавиши не должны доходить до доски: иначе «N» в названии создаст стикер.
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') props.onDone(null);
        }}
        onSubmit={(e) => {
          e.preventDefault();
          props.onDone(value());
        }}
      >
        <div class="dialog-title">{props.question}</div>
        <input ref={input} class="setup-input" value={value()} onInput={(e) => setValue(e.currentTarget.value)} />
        <div class="dialog-actions">
          <button type="button" onClick={() => props.onDone(null)}>Отмена</button>
          <button type="submit" class="primary">OK</button>
        </div>
      </form>
    </div>
  );
}
