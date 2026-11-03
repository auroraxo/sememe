// Emits research/token-metadata-oracle-2026-11-03.json: the upstream crate's
// OWN pack()/unpack() behaviour, so sememe's derivation can be falsified
// against the program itself rather than against a second reading of its source.
use spl_token_metadata_interface::instruction::{
    TokenMetadataInstruction, Initialize, UpdateField, RemoveKey, UpdateAuthority, Emit,
};
use spl_token_metadata_interface::state::Field;
use solana_address::Address;
use spl_discriminator::SplDiscriminate;

fn hx(b: &[u8]) -> String { b.iter().map(|x| format!("{:02x}", x)).collect() }
fn decode_hex(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i+2], 16).unwrap()).collect()
}

fn main() {
    let mut out = String::new();
    out.push_str("{\n");

    // 1. The discriminator RULE, computed by the crates upstream builds with.
    //    The anchor is the literal upstream hardcodes in state.rs (checked to
//    equal TokenMetadata::SPL_DISCRIMINATOR at pin time); if the
    //    sha256 rule does not reproduce it, every discriminator is wrong.
    let pre = format!("{}:token_metadata", spl_token_metadata_interface::NAMESPACE);
    let h = solana_sha256_hasher::hash(pre.as_bytes());
    let computed = hx(&h.to_bytes()[..8]);
    let anchor = hx(&[112u8, 132, 90, 90, 11, 88, 157, 87]);
    out.push_str("  \"discriminatorRule\": {\n");
    out.push_str(&format!("    \"namespace\": \"{}\",\n", spl_token_metadata_interface::NAMESPACE));
    out.push_str(&format!("    \"preimage\": \"{}\",\n", pre));
    out.push_str(&format!("    \"anchorLiteral\": \"{}\",\n", anchor));
    out.push_str(&format!("    \"computedByOracle\": \"{}\",\n", computed));
    //    The FIVE instruction discriminators, computed by the crate's OWN
    //    SplDiscriminate derive macro (spl-discriminator 0.5.2). This is the
    //    falsifier for sememe's derivation: the same strings, hashed by
    //    upstream's code, must give the same 8 bytes.
    out.push_str("    \"instructionDiscriminators\": {\n");
    out.push_str(&format!("\"Initialize\": \"{}\",\n", hx(Initialize::SPL_DISCRIMINATOR_SLICE)));
    out.push_str(&format!("\"UpdateField\": \"{}\",\n", hx(UpdateField::SPL_DISCRIMINATOR_SLICE)));
    out.push_str(&format!("\"RemoveKey\": \"{}\",\n", hx(RemoveKey::SPL_DISCRIMINATOR_SLICE)));
    out.push_str(&format!("\"UpdateAuthority\": \"{}\",\n", hx(UpdateAuthority::SPL_DISCRIMINATOR_SLICE)));
    out.push_str(&format!("\"Emit\": \"{}\"\n", hx(Emit::SPL_DISCRIMINATOR_SLICE)));
    out.push_str("    },\n");
    out.push_str("    \"oracleCrateVersions\": {\n");
    out.push_str("      \"spl-token-metadata-interface\": \"1.0.1\",\n");
    out.push_str("      \"spl-discriminator\": \"0.5.2\",\n");
    out.push_str("      \"solana-nullable\": \"1.3.0\",\n");
    out.push_str("      \"borsh\": \"1.8.1\",\n");
    out.push_str("      \"solana-address\": \"2.6.1\"\n");
    out.push_str("    }\n");
    out.push_str("  },\n");

    // 2. pack() output for every variant, from the real crate.
    out.push_str("  \"packed\": [\n");
    let cases: Vec<(String, TokenMetadataInstruction, serde_json::Value)> = vec![
        ("Initialize".into(), TokenMetadataInstruction::Initialize(Initialize {
            name: "attention".into(), symbol: "att".into(),
            uri: "https://ipfs.io/ipfs/bafkreia2sie54jyne33qx7ivxxbnohqnh2stkdvbpitqxgxyf4zzgdgg74".into(),
        }), serde_json::json!({"name":"attention","symbol":"att","uri":"https://ipfs.io/ipfs/bafkreia2sie54jyne33qx7ivxxbnohqnh2stkdvbpitqxgxyf4zzgdgg74"})),
        ("Initialize".into(), TokenMetadataInstruction::Initialize(Initialize {
            name: "charco.fun".into(), symbol: "CHARCO".into(),
            uri: "https://ipfs.io/ipfs/bafkreicij7mv4marvmppitgqqne6kvzcborp53shppzw6kqgzx3z5xeea4".into(),
        }), serde_json::json!({"name":"charco.fun","symbol":"CHARCO","uri":"https://ipfs.io/ipfs/bafkreicij7mv4marvmppitgqqne6kvzcborp53shppzw6kqgzx3z5xeea4"})),
        ("UpdateField".into(), TokenMetadataInstruction::UpdateField(UpdateField {
            field: Field::Name, value: "new_name".into(),
        }), serde_json::json!({"field":{"variant":"Name","tag":0},"value":"new_name"})),
        ("UpdateField".into(), TokenMetadataInstruction::UpdateField(UpdateField {
            field: Field::Key("custom".into()), value: "v".into(),
        }), serde_json::json!({"field":{"variant":"Key","value":"custom"},"value":"v"})),
        ("RemoveKey".into(), TokenMetadataInstruction::RemoveKey(RemoveKey {
            idempotent: true, key: "k".into(),
        }), serde_json::json!({"idempotent":true,"key":"k"})),
        ("RemoveKey".into(), TokenMetadataInstruction::RemoveKey(RemoveKey {
            idempotent: false, key: "k".into(),
        }), serde_json::json!({"idempotent":false,"key":"k"})),
        ("UpdateAuthority".into(), TokenMetadataInstruction::UpdateAuthority(UpdateAuthority {
            new_authority: solana_nullable::MaybeNull::default(),
        }), serde_json::json!({"new_authority":null})),
        ("UpdateAuthority".into(), TokenMetadataInstruction::UpdateAuthority(UpdateAuthority {
            new_authority: Address::new_from_array([7u8; 32]).into(),
        }), serde_json::json!({"new_authority":"US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx"})),
        ("Emit".into(), TokenMetadataInstruction::Emit(Emit { start: None, end: None }),
            serde_json::json!({"start":null,"end":null})),
        ("Emit".into(), TokenMetadataInstruction::Emit(Emit { start: Some(1), end: Some(9) }),
            serde_json::json!({"start":1,"end":9})),
    ];
    for (i, (name, ix, args)) in cases.iter().enumerate() {
        out.push_str("    {\"name\": \"");
        out.push_str(name);
        out.push_str("\", \"args\": ");
        out.push_str(&args.to_string());
        out.push_str(", \"hex\": \"");
        out.push_str(&hx(&ix.pack()));
        out.push_str("\"}");
        if i + 1 < cases.len() { out.push_str(",\n"); } else { out.push_str("\n"); }
    }
    out.push_str("  ],\n");

    // 3. The OBSERVED mainnet payloads, unpacked by the real crate, so the
    //    byte-exact claim is upstream's own re-encode.
    out.push_str("  \"observed\": [\n");
    let observed = vec![
        ("initialize-attention", "d2e11ea258b84d8d09000000617474656e74696f6e030000006174745000000068747470733a2f2f697066732e696f2f697066732f6261666b726569613273696535346a796e65333371783769767878626e6f68716e683273746b647662706974717867787966347a7a676467673734"),
        ("initialize-charco", "d2e11ea258b84d8d0600000043484152434f0600000043484152434f5000000068747470733a2f2f697066732e696f2f697066732f6261666b726569656f343379666d62676866696d6a33346f36737261746b76796f77786e3435346767713270693379717534776d346b35776c3469"),
        ("initialize-charco-fun", "d2e11ea258b84d8d0a00000063686172636f2e66756e0600000043484152434f5000000068747470733a2f2f697066732e696f2f697066732f6261666b72656963696a376d76346d6172766d707069746771716e65366b767a63626f72703533736870707a77366b71677a78337a357865656134"),
        ("update-authority-none", "d7e4a6e45464567b0000000000000000000000000000000000000000000000000000000000000000"),
    ];
    for (i, (label, hexstr)) in observed.iter().enumerate() {
        let bytes = decode_hex(hexstr);
        match TokenMetadataInstruction::unpack(&bytes) {
            Ok(ix) => {
                let repacked = ix.pack();
                let name = match &ix {
                    TokenMetadataInstruction::Initialize(_) => "Initialize",
                    TokenMetadataInstruction::UpdateField(_) => "UpdateField",
                    TokenMetadataInstruction::RemoveKey(_) => "RemoveKey",
                    TokenMetadataInstruction::UpdateAuthority(_) => "UpdateAuthority",
                    TokenMetadataInstruction::Emit(_) => "Emit",
                };
                out.push_str(&format!("    {{\"label\": \"{}\", \"accepted\": true, \"name\": \"{}\", \"reencodeEqual\": {}, \"hex\": \"{}\"}}",
                    label, name, repacked == bytes, hx(&repacked)));
            }
            Err(e) => out.push_str(&format!("    {{\"label\": \"{}\", \"accepted\": false, \"error\": \"{:?}\"}}", label, e)),
        }
        if i + 1 < observed.len() { out.push_str(",\n"); } else { out.push_str("\n"); }
    }
    out.push_str("  ],\n");

    // 4. What the real crate REFUSES, with the reason upstream returns.
    out.push_str("  \"refused\": [\n");
    let observed_init = "d2e11ea258b84d8d09000000617474656e74696f6e030000006174745000000068747470733a2f2f697066732e696f2f697066732f6261666b726569613273696535346a796e65333371783769767878626e6f68716e683273746b647662706974717867787966347a7a676467673734";
    let observed_auth = "d7e4a6e45464567b0000000000000000000000000000000000000000000000000000000000000000";
    let init_trailing = format!("{}00", observed_init);
    let auth_trailing = format!("{}aa", observed_auth);
    let refused: Vec<(&str, &str, &str)> = vec![
        ("unknown 8-byte discriminator", "0000000000000000", "unknown-selector"),
        ("trailing byte after UpdateAuthority", auth_trailing.as_str(), "trailing-bytes"),
        ("trailing byte after Initialize", init_trailing.as_str(), "trailing-bytes"),
        ("too short for a discriminator", "00000000000000", "truncated-discriminator"),
        ("discriminator only, no body", "d7e4a6e45464567b", "truncated-address"),
        ("forged Borsh string length", "d2e11ea258b84d8dff000000616263", "truncated-string"),
        ("Emit truncated after one option byte", "faa6b4fa0d0cb84601", "truncated-option-payload"),
        ("RemoveKey bool byte 2", "ea122038598d25b502010000006b", "invalid-bool"),
        ("Field tag 4 (undeclared)", "dde9312db5cadcc8040100000076", "unknown-enum-variant"),
    ];
    for (i, (label, hexstr, expected)) in refused.iter().enumerate() {
        let bytes = decode_hex(hexstr);
        let upstream_err = match TokenMetadataInstruction::unpack(&bytes) {
            Ok(_) => "ACCEPTED".to_string(),
            Err(e) => format!("{:?}", e),
        };
        out.push_str(&format!("    {{\"label\": \"{}\", \"hex\": \"{}\", \"upstreamError\": \"{}\", \"reason\": \"{}\"}}",
            label, hexstr, upstream_err, expected));
        if i + 1 < refused.len() { out.push_str(",\n"); } else { out.push_str("\n"); }
    }
    out.push_str("  ]\n}\n");

    println!("{}", out);
}
