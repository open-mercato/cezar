// Replays the Noise vectors through snow, a second implementation. Run from this directory.
use serde_json::Value;
use snow::{Builder, HandshakeState, TransportState};
use std::fs;

const XX: &str = "Noise_XXpsk3_25519_ChaChaPoly_SHA256";
const KK: &str = "Noise_KK_25519_ChaChaPoly_SHA256";

fn load(name: &str) -> Value {
    serde_json::from_str(&fs::read_to_string(format!("../{name}")).unwrap()).unwrap()
}
fn hx(value: &Value) -> Vec<u8> {
    hex::decode(value.as_str().unwrap()).unwrap()
}
fn write(from: &mut HandshakeState, to: &mut HandshakeState, payload: &[u8], expected: &[u8]) {
    let mut message = vec![0u8; 65535];
    let length = from.write_message(payload, &mut message).unwrap();
    assert_eq!(&message[..length], expected, "handshake message differs");
    let mut read = vec![0u8; 65535];
    let got = to.read_message(&message[..length], &mut read).unwrap();
    assert_eq!(&read[..got], payload, "handshake payload differs");
}
fn seal(transport: &mut TransportState, record: &[u8], expected: &[u8]) {
    let mut out = vec![0u8; 65535];
    let length = transport.write_message(record, &mut out).unwrap();
    assert_eq!(&out[..length], expected, "transport ciphertext differs");
}
fn unseal(transport: &mut TransportState, ciphertext: &[u8], expected: &[u8]) {
    let mut out = vec![0u8; 65535];
    let length = transport.read_message(ciphertext, &mut out).unwrap();
    assert_eq!(&out[..length], expected, "transport plaintext differs");
}

fn xxpsk3() {
    let v = load("handshake-xxpsk3.json");
    let prologue = hx(&v["prologue"]);
    let psk: [u8; 32] = hx(&v["psk"]).try_into().unwrap();
    let (ps, pe) = (hx(&v["phone"]["x25519Secret"]), hx(&v["phone"]["ephemeralSecret"]));
    let (cs, ce) = (hx(&v["cezar"]["x25519Secret"]), hx(&v["cezar"]["ephemeralSecret"]));
    let params = XX.parse().unwrap();
    let mut phone = Builder::new(params).prologue(&prologue).unwrap().psk(3, &psk).unwrap()
        .local_private_key(&ps).unwrap().fixed_ephemeral_key_for_testing_only(&pe)
        .build_initiator().unwrap();
    let params = XX.parse().unwrap();
    let mut cezar = Builder::new(params).prologue(&prologue).unwrap().psk(3, &psk).unwrap()
        .local_private_key(&cs).unwrap().fixed_ephemeral_key_for_testing_only(&ce)
        .build_responder().unwrap();
    let m = v["messages"].as_array().unwrap();
    write(&mut phone, &mut cezar, &hx(&m[0]["payload"]), &hx(&m[0]["message"]));
    write(&mut cezar, &mut phone, &hx(&m[1]["payload"]), &hx(&m[1]["message"]));
    write(&mut phone, &mut cezar, &hx(&m[2]["payload"]), &hx(&m[2]["message"]));
    assert_eq!(phone.get_handshake_hash(), &hx(&v["handshakeHash"])[..], "handshake hash differs");
    let mut phone = phone.into_transport_mode().unwrap();
    let mut cezar = cezar.into_transport_mode().unwrap();
    let pending = &v["afterHandshake"]["pending"];
    let record = hx(&pending["record"]);
    seal(&mut cezar, &record, &hx(&pending["ciphertext"]));
    unseal(&mut phone, &hx(&pending["ciphertext"]), &record);
    println!("ok {XX}: 3 handshake messages, hash, pending");
}

fn session() -> (TransportState, TransportState) {
    let v = load("session-kk.json");
    let prologue = hx(&v["prologue"]);
    let (ps, pe, pp) = (hx(&v["phone"]["x25519Secret"]), hx(&v["phone"]["ephemeralSecret"]), hx(&v["phone"]["x25519Public"]));
    let (cs, ce, cp) = (hx(&v["cezar"]["x25519Secret"]), hx(&v["cezar"]["ephemeralSecret"]), hx(&v["cezar"]["x25519Public"]));
    let params = KK.parse().unwrap();
    let mut phone = Builder::new(params).prologue(&prologue).unwrap().local_private_key(&ps).unwrap()
        .remote_public_key(&cp).unwrap().fixed_ephemeral_key_for_testing_only(&pe).build_initiator().unwrap();
    let params = KK.parse().unwrap();
    let mut cezar = Builder::new(params).prologue(&prologue).unwrap().local_private_key(&cs).unwrap()
        .remote_public_key(&pp).unwrap().fixed_ephemeral_key_for_testing_only(&ce).build_responder().unwrap();
    write(&mut phone, &mut cezar, &[], &hx(&v["first"]["message"]));
    write(&mut cezar, &mut phone, &hx(&v["second"]["payload"]), &hx(&v["second"]["message"]));
    assert_eq!(phone.get_handshake_hash(), &hx(&v["handshakeHash"])[..], "handshake hash differs");
    (phone.into_transport_mode().unwrap(), cezar.into_transport_mode().unwrap())
}

fn kk() {
    let v = load("session-kk.json");
    let (mut phone, mut cezar) = session();
    let transcript = v["transcript"].as_array().unwrap();
    for item in transcript {
        let (record, ciphertext) = (hx(&item["record"]), hx(&item["ciphertext"]));
        if item["from"] == "phone" {
            seal(&mut phone, &record, &ciphertext);
            unseal(&mut cezar, &ciphertext, &record);
        } else {
            seal(&mut cezar, &record, &ciphertext);
            unseal(&mut phone, &ciphertext, &record);
        }
    }
    println!("ok {KK}: 2 handshake messages, hash, {} transport frames", transcript.len());
}

fn rekey() {
    let v = load("rekey.json");
    let (mut phone, mut cezar) = session();
    let steps = v["steps"].as_array().unwrap();
    for step in steps {
        let (record, ciphertext) = (hx(&step["record"]), hx(&step["ciphertext"]));
        seal(&mut phone, &record, &ciphertext);
        unseal(&mut cezar, &ciphertext, &record);
        if step["name"].as_str().unwrap().starts_with("REKEY") {
            phone.rekey_outgoing();
            cezar.rekey_incoming();
        }
    }
    let other = &v["otherDirection"];
    seal(&mut cezar, &hx(&other["record"]), &hx(&other["ciphertext"]));
    unseal(&mut phone, &hx(&other["ciphertext"]), &hx(&other["record"]));
    println!("ok rekey: {} frames across 2 rekeys, other direction unchanged", steps.len());
}

fn main() {
    xxpsk3();
    kk();
    rekey();
}
