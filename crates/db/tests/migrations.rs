use datix_db::{
    connect_owner,
    migrations::{self, Migration},
    schema,
};
use sha2::{Digest, Sha256};

#[tokio::test]
#[ignore = "Requires DATIX_TEST_ENV and the isolated Rust Neon branch"]
async fn migration_failures_roll_back_schema_and_history_and_baselines_reject_drift() {
    let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(std::env::var("DATIX_TEST_ENV").expect("DATIX_TEST_ENV required"));
    let env: std::collections::HashMap<_, _> = dotenvy::from_path_iter(file)
        .unwrap()
        .map(Result::unwrap)
        .collect();
    let url = &env["DATABASE_URL_UNPOOLED"];
    let identity = datix_db::identity(url).unwrap();
    assert_eq!(
        identity.host,
        "ep-sweet-sun-b1ynkxmz.c-5.eu-central-1.aws.neon.tech"
    );
    assert_eq!(identity.database, "datix");
    let (mut connection, _) = connect_owner(url, &identity.host, &identity.database)
        .await
        .unwrap();
    let expected = migrations::bundled();
    let original = migrations::applied(&mut connection).await.unwrap();
    assert!(
        migrations::run(&mut connection, &expected, false)
            .await
            .unwrap()
            .is_empty()
    );
    let mut failing = expected.clone();
    let sql = "CREATE TABLE public.rust_migration_atomicity_fixture(id integer); SELECT 1/0;";
    failing.push(Migration {
        name: "0002_atomicity_fixture.sql".into(),
        sql: sql.into(),
        checksum: hex::encode(Sha256::digest(sql.as_bytes())),
    });
    assert!(
        migrations::run(&mut connection, &failing, true)
            .await
            .is_err()
    );
    let exists: bool = sqlx::query_scalar(
        "SELECT to_regclass('public.rust_migration_atomicity_fixture') IS NOT NULL",
    )
    .fetch_one(&mut connection)
    .await
    .unwrap();
    assert!(!exists);
    assert_eq!(
        migrations::applied(&mut connection).await.unwrap(),
        original
    );
    let mut changed = expected.clone();
    changed[0].checksum = "modified".into();
    assert!(
        migrations::run(&mut connection, &changed, true)
            .await
            .is_err()
    );
    assert_eq!(
        migrations::applied(&mut connection).await.unwrap(),
        original
    );
    let mut snapshot = schema::snapshot(&mut connection).await.unwrap();
    for key in [
        "tables",
        "views",
        "sequences",
        "policies",
        "types",
        "extensions",
    ] {
        assert!(
            snapshot.schema[key].is_array(),
            "Missing catalog metadata: {key}"
        );
    }
    schema::baseline(&mut connection, &snapshot, &expected, false)
        .await
        .unwrap();
    let original_rls = snapshot.schema["tables"][0]["relrowsecurity"].clone();
    snapshot.schema["tables"][0]["relrowsecurity"] =
        serde_json::json!(!original_rls.as_bool().unwrap());
    assert!(
        schema::baseline(&mut connection, &snapshot, &expected, true)
            .await
            .is_err()
    );
    snapshot.schema["tables"][0]["relrowsecurity"] = original_rls;
    snapshot.schema["columns"][0]["type"] = "different".into();
    assert!(
        schema::baseline(&mut connection, &snapshot, &expected, true)
            .await
            .is_err()
    );
    assert_eq!(
        migrations::applied(&mut connection).await.unwrap(),
        original
    );
}
