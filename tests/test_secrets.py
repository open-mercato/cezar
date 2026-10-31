from pathlib import Path

from app.secrets.store import SecretsError, SecretStore, command_allowed, name_issue


def test_names_that_steer_the_shell_are_refused(tmp_path: Path):
    store = SecretStore(tmp_path / "secrets")
    assert name_issue("PATH")
    assert name_issue("CEZ_HOME")
    assert name_issue("not_upper")
    try:
        store.set("proj", "PATH", "x", root=str(tmp_path))
    except SecretsError as exc:
        assert "shell" in str(exc)
    else:
        raise AssertionError("PATH was stored")


def test_a_project_file_does_not_open_for_another_root(tmp_path: Path):
    store = SecretStore(tmp_path / "secrets")
    store.set("proj", "BUILD_TOKEN", "super-secret-value", root=str(tmp_path / "one"))
    values, notes = store.resolve("checks", project_id="proj", root=str(tmp_path / "two"))
    assert values == {}
    assert notes and "another project root" in notes[0]
    own, own_notes = store.resolve("checks", project_id="proj", root=str(tmp_path / "one"))
    assert own["BUILD_TOKEN"] == "super-secret-value"
    assert own_notes == []
    listed, _skipped = store.list("proj", root=str(tmp_path / "one"))
    assert listed[0].name == "BUILD_TOKEN"
    assert "super-secret-value" not in repr(listed)


def test_a_cezar_audience_is_not_given_to_checks(tmp_path: Path):
    store = SecretStore(tmp_path / "secrets")
    store.set("workspace", "LLM_KEY", "not-for-checks-please", audiences=("cezar",))
    values, _notes = store.resolve("checks", project_id="proj", root=str(tmp_path))
    assert "LLM_KEY" not in values


def test_a_keychain_holds_the_data_key_and_zero_forces_the_file(tmp_path: Path, monkeypatch):
    from app.secrets.keychain import MemoryKeyring, clear_keychain_override, set_keychain

    monkeypatch.delenv("CEZ_SECRETS_KEYCHAIN", raising=False)
    ring = MemoryKeyring()
    set_keychain(ring)
    try:
        store = SecretStore(tmp_path / "secrets")
        assert store.key_backend() == "keychain"
        store.set("proj", "BUILD_TOKEN", "super-secret-value", root=str(tmp_path))
        assert ring.value is not None and len(ring.value) == 32
        assert not (tmp_path / "secrets" / ".key").exists()
        again = SecretStore(tmp_path / "secrets")
        values, notes = again.resolve("checks", project_id="proj", root=str(tmp_path))
        assert values["BUILD_TOKEN"] == "super-secret-value"
        assert notes == []
        ring.locked = True
        locked = SecretStore(tmp_path / "secrets")
        try:
            locked.resolve("checks", project_id="proj", root=str(tmp_path))
        except SecretsError as exc:
            assert "locked" in str(exc)
        else:
            raise AssertionError("a locked keychain decrypted")
    finally:
        clear_keychain_override()

    monkeypatch.setenv("CEZ_SECRETS_KEYCHAIN", "0")
    set_keychain(MemoryKeyring())
    try:
        file_store = SecretStore(tmp_path / "file-secrets")
        assert file_store.key_backend() == "file"
        file_store.set("proj", "BUILD_TOKEN", "file-secret-value", root=str(tmp_path))
        assert (tmp_path / "file-secrets" / ".key").is_file()
    finally:
        clear_keychain_override()


def test_an_empty_allowlist_is_unrestricted_and_a_list_is_a_prefix():
    assert command_allowed("rm -rf /", ()) is True
    assert command_allowed("npm test", ("npm",)) is True
    assert command_allowed("npx npm", ("npm",)) is False
