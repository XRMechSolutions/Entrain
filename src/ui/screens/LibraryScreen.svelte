<!-- LibraryScreen — the Phase-1 preset picker (design §7/§9/§13). Header: New / Import /
     Install; a refreshable list with Open / Export / Delete (Delete + discard-on-dirty are
     confirmed in the store). Export/Import are called DIRECTLY from the click (download /
     file-picker gesture policies — no await before them, edge E11). Refreshes on mount. -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { getAppContext } from '../context';
  import { createDefaultPreset } from '../../engine/session-model';
  import PresetList from '../components/PresetList.svelte';
  import InstallPrompt from '../components/InstallPrompt.svelte';

  const { session, library, install, ui } = getAppContext();

  onMount(() => {
    library.refresh();
  });

  function newSession(): void {
    if (session.dirty && !confirm('Discard unsaved changes?')) return;
    session.reset(createDefaultPreset());
  }
</script>

<section class="library">
  <header class="header">
    <h1 class="title">Library</h1>
    <div class="header-actions">
      <button type="button" class="hbtn" onclick={newSession}>New</button>
      <button
        type="button"
        class="hbtn"
        onclick={() => {
          // importFromFile() opens the picker IN this click (gesture, edge E11), auto-saves the
          // file, then resolves true — jump to the Advanced editor so the user lands ready to shape it.
          void library.importFromFile().then((ok) => {
            if (ok) ui.setTab('editor');
          });
        }}>Import</button>
      <button type="button" class="hbtn" onclick={() => library.restoreDefaults()}>Restore defaults</button>
      <InstallPrompt
        canInstall={install.canInstall}
        isIos={install.isIos}
        oninstall={() => install.promptInstall()}
      />
    </div>
  </header>

  <div class="save-row">
    <button type="button" class="hbtn" onclick={() => library.saveCurrent()}>Save</button>
    <button type="button" class="hbtn" onclick={() => library.saveAsNew()}>Save as new</button>
    <button type="button" class="hbtn" onclick={() => library.exportCurrent()}>Export current</button>
  </div>

  <PresetList
    items={library.items}
    selectedId={session.selectedId}
    onopen={(id) => {
      // Open a preset, then jump to the Advanced editor so the user lands ready to shape it.
      // Navigate only on a SUCCESSFUL open (open() aborts on a dirty-discard cancel / a
      // since-deleted row — both leave selectedId !== id), mirroring the onexport guard below.
      library.open(id);
      if (session.selectedId === id) ui.setTab('editor');
    }}
    onexport={(id) => {
      // Export a saved row: adopt it as the working preset (honours dirty-confirm), then
      // export synchronously in the same gesture. Skip the export if the open was cancelled.
      library.open(id);
      if (session.selectedId === id) library.exportCurrent();
    }}
    onremove={(id) => library.remove(id)}
  />
</section>

<style>
  .library {
    display: flex;
    flex-direction: column;
    gap: var(--sp-4);
    padding: var(--sp-4);
  }
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-3);
    flex-wrap: wrap;
  }
  .title {
    font-size: 1.2rem;
    margin: 0;
  }
  .header-actions,
  .save-row {
    display: flex;
    gap: var(--sp-2);
    flex-wrap: wrap;
  }
  .hbtn {
    min-height: var(--tap-min);
    padding: 0 var(--sp-3);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text);
    font-size: 0.9rem;
  }
</style>
