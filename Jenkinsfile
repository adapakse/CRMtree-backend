@Library("sonar")_

pipeline {
    agent any

    parameters {
        choice(name: "NODEJS_VERSION", choices: ["~v22", "~v18"], description: "Wersja Node.js (nazwa narzędzia w Jenkins)")
    }

    environment {
        BASTION_REGISTRY_URL          = credentials("BASTION_REGISTRY")
        BASTION_NCA_REGISTRY_URL       = "registry.org.hotailors.com/hotailors/travel-platform/docs/worktripsdoc"
        TEAMS_SUCCESS_WEBHOOK_URL      = credentials("TEAMS_SUCCESS_WEBHOOK_URL")
        TEAMS_FAILURE_WEBHOOK_URL      = credentials("TEAMS_FAILURE_WEBHOOK_URL")
        GITLAB_REGISTRY_ACCOUNT_CREDENTIAL_ID = credentials("GITLAB_REGISTRY_ACCOUNT_CREDENTIAL_ID")
        BASTION_REGISTRY_ACCOUNT_CREDENTIAL_ID = credentials("BASTION_REGISTRY_ACCOUNT_CREDENTIAL_ID")
    }

    stages {
        stage("Inicjalizacja parametrów") {
            steps {
                script {
                    env.NODEJS = params.NODEJS_VERSION ?: "~v22"
                    echo "Node.js: ${env.NODEJS}"
                }
            }
        }

    stage("Skan repozytorium Trivy") {
        steps {
            script {
                def workspace = pwd()
                def cacheDir = "/media/BuildDrive/jenkins/trivy-cache"

                sh "mkdir -p '${cacheDir}'"

                echo "Workspace do skanowania: ${workspace}"
                echo "Cache Trivy: ${cacheDir}"

                sh """
                    docker run --rm \
                        -v "${workspace}":/project \
                        -v "${cacheDir}":/root/.cache/trivy \
                        aquasec/trivy:latest \
                        repo /project \
                        --exit-code 0 \
                        --severity HIGH,CRITICAL \
                        --no-progress \
                        --scanners vuln,secret,config || true
                """
                }
            }
        }       


        stage("Instalacja zależności") {
            steps {
                timeout(time: 10, unit: 'MINUTES') {
                    nodejs(nodeJSInstallationName: env.NODEJS) {
                        sh "npm ci --prefer-offline --no-audit"
                    }
                }
            }
        }

        stage("Lint") {
            steps {
                nodejs(nodeJSInstallationName: env.NODEJS) {
                    catchError(buildResult: 'SUCCESS', stageResult: 'UNSTABLE') {
                        sh "npm run lint"
                    }
                }
            }
        }

        stage("Sprawdzenie formatowania") {
            steps {
                nodejs(nodeJSInstallationName: env.NODEJS) {
                catchError(buildResult: 'SUCCESS', stageResult: 'UNSTABLE') {
                    sh "npm run format:check"
                    }
                }
            }
        }

        // stage("Testy") {
        //     steps {
        //         nodejs(nodeJSInstallationName: env.NODEJS) {
        //             sh "npm run test:cov-ci -- --maxWorkers=2"
        //         }
        //     }
        // }

        stage("Budowa obrazu Docker") {
            steps {
                script {

                    docker.withRegistry(BASTION_REGISTRY_URL, BASTION_REGISTRY_ACCOUNT_CREDENTIAL_ID) {
                        def image = docker.build("${BASTION_NCA_REGISTRY_URL}:${BUILD_NUMBER}",
                            ".")
                        env.BASTION_IMAGE = image.id
                    }
                }
            }
        }

        stage("Skan Trivy obrazu") {
            steps {
                script {
                    def imageToScan = "${BASTION_NCA_REGISTRY_URL}"
                    def trivyCache = "/media/BuildDrive/jenkins/trivy-cache"

                    sh "mkdir -p ${trivyCache}"

                    echo "Skanowanie obrazu: ${imageToScan}"
                    sh """
                        docker run --rm \
                            -v /var/run/docker.sock:/var/run/docker.sock \
                            -v ${trivyCache}:/root/.cache/trivy \
                            aquasec/trivy:latest \
                            image --exit-code 0 --severity HIGH,CRITICAL \
                            --no-progress \
                            ${imageToScan} || true
                    """
                }
            }
        }

        stage("Wysłanie obrazu do rejestru") {
            steps {
                script {
                    docker.withRegistry(BASTION_REGISTRY_URL, BASTION_REGISTRY_ACCOUNT_CREDENTIAL_ID) {
                        docker.image(env.BASTION_IMAGE).push()
                    }
                }
            }
        }

        stage("Oczekiwanie na propagację w rejestrze") {
            steps {
                sleep 15
            }
        }


        stage("Update tag") {
            steps {
                sshagent(credentials: [params.GIT_IDENTITY]) {
                    withEnv(["FILE_TO_EDIT=values-htpre.yaml"]) {
                    sh """
                        git clone --branch master git@bastion.org.hotailors.com:worktrips-admin/kubernetes.git argo_commit_workspace
                        cd argo_commit_workspace
                        git checkout master
                        git config pull.rebase false
                        git pull
                        cd docs_app

                        sed -i "/^docs-back:/,/^[^ ]/ s/\\(tag: *\\).*/\\1\"'"$BUILD_NUMBER"'\"/" "$FILE_TO_EDIT"

                        git add "$FILE_TO_EDIT"
                        git commit -m "bump image version for ${params.ENV}"
                        git push
                    """
                    }
                }
            }
        }

    }

    post {
        success {
            office365ConnectorSend color: '#00CC00', message: "Build ${BUILD_NUMBER} zakończony sukcesem ✅", webhookUrl: TEAMS_SUCCESS_WEBHOOK_URL
        }
        //failure {
          //  office365ConnectorSend color: '#C00000', message: "Build ${BUILD_NUMBER} ZAKOŃCZONY BŁĘDEM ❌", webhookUrl: TEAMS_FAILURE_WEBHOOK_URL
       // }
        always {
            junit '**/junit.xml'
            archiveArtifacts artifacts: 'eslint.report.json', allowEmptyArchive: true
        }
        cleanup {
            deleteDir()
        }
    }
}